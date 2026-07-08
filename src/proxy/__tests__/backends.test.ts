/**
 * Extra backends — GraphQL (args wrapped as { query, variables }) and WebSocket
 * (ephemeral request/response), both as per-tool config on a REST client.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import * as ipValidatorMod from "../../net/ip-validator.js";
import {
  getToolGraphql,
  getGraphqlForClient,
  setToolGraphql,
  getToolWs,
  getWsForClient,
  setToolWs,
  wsRequest,
  wsRequestPersistent,
} from "../../proxy/backends.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const gqlTool: RestToolDefinition = {
  name: "gql",
  method: "POST",
  endpoint: "/graphql",
  description: "gql",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};
const wsTool: RestToolDefinition = {
  name: "wst",
  method: "POST",
  endpoint: "/ws",
  description: "ws",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [gqlTool, wsTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const origPrivate = config.allowPrivateIps;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).allowPrivateIps = origPrivate;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

describe("GraphQL", () => {
  test("config persistence", async () => {
    await reg();
    expect(setToolGraphql(CLIENT, "nope", { enabled: true, query: "{x}" })).toBe(false);
    expect(setToolGraphql(CLIENT, "gql", { enabled: true, query: "query($q:String){f(q:$q)}" })).toBe(true);
    expect(getToolGraphql(CLIENT, "gql")).toEqual({ enabled: true, query: "query($q:String){f(q:$q)}" });
    expect(setToolGraphql(CLIENT, "gql", null)).toBe(true);
    expect(getToolGraphql(CLIENT, "gql")).toBeNull();
  });

  test("proxy wraps args into a { query, variables } POST body", async () => {
    await reg();
    setToolGraphql(CLIENT, "gql", { enabled: true, query: "query($q:String){f(q:$q)}" });
    let sentBody: unknown;
    globalThis.fetch = (async (_url: string, opts: RequestInit) => {
      sentBody = JSON.parse(String(opts.body));
      return new Response('{"data":{"f":1}}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__gql`, { q: "hi" });
    expect(sentBody).toEqual({ query: "query($q:String){f(q:$q)}", variables: { q: "hi" } });
    expect(JSON.parse(r.content[0].text)).toEqual({ data: { f: 1 } });
  });
});

describe("WebSocket", () => {
  test("rejects a non-ws URL; accepts a valid one", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    expect(await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "http://1.2.3.4" })).toMatchObject({
      ok: false,
      error: "INVALID_URL",
    });
    expect(await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://5.6.7.8" })).toEqual({ ok: true });
    expect(getToolWs(CLIENT, "wst")?.resolvedIp).toBe("5.6.7.8");
  });

  test("proxy performs a WS request/response round-trip", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no");
      },
      websocket: {
        message(ws, msg) {
          ws.send(`echo:${msg}`);
        },
      },
    });
    try {
      const setRes = await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: `ws://localhost:${server.port}` });
      expect(setRes.ok).toBe(true);
      const r = await proxyToolCall(`${CLIENT}__wst`, { msg: "hi" });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe('echo:{"msg":"hi"}');
    } finally {
      server.stop(true);
    }
  });

  describe("persistent mode", () => {
    /** A server that answers with 3 messages per call, then closes. */
    function multiMessageServer() {
      return Bun.serve({
        port: 0,
        fetch(req, srv) {
          return srv.upgrade(req) ? undefined : new Response("no");
        },
        websocket: {
          message(ws, msg) {
            ws.send(`first:${msg}`);
            setTimeout(() => ws.send(`second:${msg}`), 10);
            setTimeout(() => {
              ws.send(`third:${msg}`);
              ws.close();
            }, 20);
          },
        },
      });
    }

    test("wsRequest (non-persistent) still closes after the first message even when the server sends more", async () => {
      const server = multiMessageServer();
      try {
        const result = await wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000);
        expect(result).toBe("first:hi");
      } finally {
        server.stop(true);
      }
    });

    test("wsRequestPersistent forwards every message via onMessage and resolves with the last one", async () => {
      const server = multiMessageServer();
      try {
        const received: string[] = [];
        const result = await wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000, (data) =>
          received.push(data),
        );
        expect(received).toEqual(["first:hi", "second:hi", "third:hi"]);
        expect(result).toBe("third:hi");
      } finally {
        server.stop(true);
      }
    });

    test("proxy dispatch in persistent mode returns the last message", async () => {
      await reg();
      (config as Record<string, unknown>).allowPrivateIps = true;
      const server = multiMessageServer();
      try {
        const setRes = await setToolWs(CLIENT, "wst", {
          enabled: true,
          wsUrl: `ws://localhost:${server.port}`,
          persistent: true,
        });
        expect(setRes.ok).toBe(true);
        expect(getToolWs(CLIENT, "wst")?.persistent).toBe(true);
        const r = await proxyToolCall(`${CLIENT}__wst`, { msg: "hi" });
        expect(r.isError).toBeUndefined();
        expect(r.content[0].text).toBe('third:{"msg":"hi"}');
      } finally {
        server.stop(true);
      }
    });

    test("wsRequestPersistent resolves with the last message on timeout if the server never closes", async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req, srv) {
          return srv.upgrade(req) ? undefined : new Response("no");
        },
        websocket: {
          message(ws, msg) {
            ws.send(`only:${msg}`);
            // Deliberately never closes — resolution must come from the timeout.
          },
        },
      });
      try {
        const result = await wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 100, 1_000_000);
        expect(result).toBe("only:hi");
      } finally {
        server.stop(true);
      }
    });
  });
});

// ===========================================================================
// Mutation backstop: the config getters' enabled/persistent mapping, the
// batched getters, setToolWs's delete + exact validation reasons, and
// wsRequest's over-cap / early-close rejections.
// ===========================================================================

describe("backends — config getter mappings", () => {
  test("getToolGraphql / getGraphqlForClient map enabled=false (kills L28)", async () => {
    await reg();
    setToolGraphql(CLIENT, "gql", { enabled: false, query: "{y}" });
    expect(getToolGraphql(CLIENT, "gql")?.enabled).toBe(false);
    expect(getGraphqlForClient(CLIENT)).toEqual({ gql: { enabled: false, query: "{y}" } });
  });

  // A false-only case can't distinguish the real `r.enabled === 1` from a forced-
  // `false` ConditionalExpression mutant: both yield enabled:false when the stored
  // row is 0. Only a true-input case, read back through the *batched* getter (the
  // loop body the mutant actually lives in), can kill it.
  test("getGraphqlForClient maps enabled=true (kills L37 ConditionalExpression -> false)", async () => {
    await reg();
    setToolGraphql(CLIENT, "gql", { enabled: true, query: "{x}" });
    expect(getGraphqlForClient(CLIENT)).toEqual({ gql: { enabled: true, query: "{x}" } });
  });

  test("getToolWs / getWsForClient map enabled=false + persistent=false (kills L75)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    await setToolWs(CLIENT, "wst", { enabled: false, wsUrl: "ws://5.6.7.8", persistent: false });
    const ws = getToolWs(CLIENT, "wst");
    expect(ws?.enabled).toBe(false);
    expect(ws?.persistent).toBe(false);
    expect(getWsForClient(CLIENT).wst).toMatchObject({ enabled: false, persistent: false, resolvedIp: "5.6.7.8" });
  });

  // Same reasoning as the GraphQL true-case above, for getWsForClient's two
  // boolean mappings (enabled at L93, persistent at L96) — both need a true-input
  // case read back through the batched getter, not just getToolWs's single-row path.
  test("getWsForClient maps enabled=true + persistent=true (kills L93/L96 ConditionalExpression -> false)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://5.6.7.8", persistent: true });
    expect(getWsForClient(CLIENT).wst).toEqual({
      enabled: true,
      wsUrl: "ws://5.6.7.8",
      resolvedIp: "5.6.7.8",
      persistent: true,
    });
  });
});

describe("backends — setToolWs delete + validation reasons", () => {
  test("a non-ws:// scheme returns the exact reason (kills L113 reason)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    expect(await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "http://5.6.7.8" })).toMatchObject({
      ok: false,
      error: "INVALID_URL",
      reason: "must be ws:// or wss://",
    });
  });

  test("an SSRF-blocked ws URL surfaces the validator's reason (kills L117)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = false; // loopback must be blocked
    const blocked = await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://127.0.0.1" });
    expect(blocked).toMatchObject({ ok: false, error: "INVALID_URL" });
    if (!blocked.ok) expect(typeof blocked.reason).toBe("string");
  });

  test("passing null deletes the row (kills L109/L110)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://5.6.7.8" });
    expect(await setToolWs(CLIENT, "wst", null)).toEqual({ ok: true });
    expect(getToolWs(CLIENT, "wst")).toBeNull();
  });

  // Exact-object (not just ok:false, not just truthy) assertion: this single
  // expectation kills all 4 survivors reported at L108 — ObjectLiteral->{} (return
  // shape would be {} instead of the real object), ConditionalExpression->false
  // (the `if` never fires, so a nonexistent tool falls through into the rest of
  // the function instead of short-circuiting), BooleanLiteral->true (ok:true), and
  // StringLiteral->'' (error:"" instead of "TOOL_NOT_FOUND") — any one of those
  // makes the returned object diverge from the exact shape asserted here.
  test("a nonexistent tool returns the exact TOOL_NOT_FOUND object (kills L108 x4)", async () => {
    await reg();
    const result = await setToolWs(CLIENT, "nope", { enabled: true, wsUrl: "ws://5.6.7.8" });
    expect(result).toEqual({ ok: false, error: "TOOL_NOT_FOUND" });
  });

  // The real regex is anchored (`/^wss?:\/\//`); the surviving mutant drops the
  // `^` anchor, turning the scheme check into a mere substring search. A URL that
  // *contains* "ws://" later on but doesn't start with it is rejected by the real
  // (anchored) regex and wrongly accepted-past-this-check by the mutant.
  test("a URL containing 'ws://' as a substring, not a scheme, is rejected (kills L113 Regex -> /wss?:\\/\\// unanchored)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    const result = await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "http://evil.example.com/ws://fake" });
    expect(result).toEqual({ ok: false, error: "INVALID_URL", reason: "must be ws:// or wss://" });
  });
});

// L115's `input.wsUrl.replace(/^ws/, "http")` mutant (Regex -> /ws/, dropping the
// `^` anchor) is EQUIVALENT given this function's own control flow: by the time
// L115 runs, L113 has already guaranteed `wsUrl` starts with "ws"/"wss", so the
// leftmost (and only, since .replace with a non-global regex replaces just the
// first match) occurrence of "ws" in the string is always at index 0 — anchored
// or not. Verified empirically (`bun -e`) across multiple inputs, incl. ones with
// "ws" repeated later in the string (e.g. "wss://ws-echo.example.com/path"):
// `.replace(/^ws/, "http")` and `.replace(/ws/, "http")` produce byte-identical
// output in every case reachable past L113's guard. No test can distinguish them.

describe("backends — setToolWs L117 valid/resolvedIp guard", () => {
  test("rejects when only one of valid/resolvedIp is falsy (kills L117 LogicalOperator || -> &&)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    const spy = spyOn(ipValidatorMod, "validateBackendUrl");
    try {
      // valid:true, resolvedIp missing — real `||` rejects (resolvedIp is falsy);
      // the `&&` mutant needs BOTH falsy, so with valid:true it would wrongly proceed.
      spy.mockResolvedValueOnce({ valid: true, resolvedIp: undefined });
      const r1 = await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://mocked.example" });
      expect(r1).toMatchObject({ ok: false, error: "INVALID_URL" });

      // valid:false, resolvedIp present — the mirror asymmetry, other side.
      spy.mockResolvedValueOnce({ valid: false, resolvedIp: "9.9.9.9", reason: "blocked" });
      const r2 = await setToolWs(CLIENT, "wst", { enabled: true, wsUrl: "ws://mocked.example" });
      expect(r2).toMatchObject({ ok: false, error: "INVALID_URL", reason: "blocked" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("backends — wsRequest cap + early close", () => {
  test("rejects a message larger than maxBytes (kills L164 maxBytes check)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws) {
          ws.send("x".repeat(50));
        },
      },
    });
    try {
      await expect(wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 10)).rejects.toThrow("MAX_RESPONSE_BYTES");
    } finally {
      server.stop(true);
    }
  });

  test("rejects when the socket closes before any message (kills L171 close handler)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message() {
          /* never sends — the connection is closed on open */
        },
        open(ws) {
          ws.close();
        },
      },
    });
    try {
      await expect(wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "closed before a response",
      );
    } finally {
      server.stop(true);
    }
  });
});

// ===========================================================================
// wsRequest / wsRequestPersistent mutation backstop (P2-4, owns L132-233 only):
// close-as-observable-side-effect, timeout/close null-branches, binary-frame
// fallback, exact cap boundary, real protocol-error rejection, and the
// settled-guard reentrancy hazard exposed by wsRequestPersistent's cap check
// calling finish() while the socket is still open. Every server below is a real
// Bun.serve({ port: 0, ... }) — no WebSocket mocking.
// ===========================================================================

describe("backends — wsRequest close is an observable side effect", () => {
  test("wsRequest actually closes the socket before settling — the server sees a close (kills L145 BlockStatement -> '{}')", async () => {
    let serverSawClose = false;
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws) {
          ws.send("resp");
        },
        close() {
          serverSawClose = true;
        },
      },
    });
    try {
      const result = await wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000);
      expect(result).toBe("resp");
      // The client-side `ws.close()` inside `finish` is what makes the server
      // observe a close; if the try block were emptied (the mutant), the socket
      // would linger open and the server's close handler would never fire.
      const deadline = Date.now() + 1000;
      while (!serverSawClose && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(serverSawClose).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequest timeout rejection", () => {
  test("rejects with the exact 'timeout' message when the server never responds (kills L153 ArrowFunction x2 + StringLiteral -> '')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message() {
          /* never responds — resolution must come from the timeout */
        },
      },
    });
    try {
      await expect(wsRequest(`ws://localhost:${server.port}`, "hi", 50, 1_000_000)).rejects.toThrow("timeout");
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequest binary payload + cap boundary", () => {
  test("a non-string (binary) WS message is treated as an empty string, not passed through raw (kills L163 ConditionalExpression -> true + StringLiteral fallback -> 'Stryker was here!')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          ws.send(new Uint8Array([1, 2, 3, 4])); // binary frame: ev.data is a Buffer, not a string
        },
        message() {},
      },
    });
    try {
      const result = await wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 100);
      expect(result).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("resolves (does not reject) when a message's length is exactly maxBytes — boundary (kills L164 EqualityOperator > -> >=)", async () => {
    const N = 10;
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws) {
          ws.send("x".repeat(N));
        },
      },
    });
    try {
      const result = await wsRequest(`ws://localhost:${server.port}`, "hi", 2000, N);
      expect(result).toBe("x".repeat(N));
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequest real protocol error", () => {
  test("rejects with the exact 'WebSocket error' message on a real failed handshake (kills L170 StringLiteral x2 + ArrowFunction x2)", async () => {
    // The server refuses the upgrade outright (a plain HTTP response, no 101) —
    // verified empirically that a real client WebSocket fires a genuine `error`
    // event for this (before `close`), so this exercises the actual error
    // listener rather than relying on `close` alone.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 400 }),
    });
    try {
      await expect(wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "WebSocket error",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequest send() cannot throw in practice (equivalent mutants)", () => {
  // NOTE — equivalent mutant, verified empirically: L158/159 (BlockStatement ->
  // '{}' on the `catch (e)` body, and the ArrowFunction inside it,
  // `finish(() => reject(...))`) guard against `ws.send` throwing synchronously
  // inside the `open` handler. A real WebSocket client's `readyState` is
  // guaranteed OPEN for the entire synchronous body of its own `open` handler —
  // JS is single-threaded, so nothing can transition the socket to
  // CLOSING/CLOSED between the event firing and this handler's synchronous code
  // running — and per the WHATWG WebSocket spec, `send()` only throws
  // (InvalidStateError) when readyState is CONNECTING, which is impossible at
  // this call site. Confirmed live (a real Bun.serve client/server round trip,
  // including a server that closes the connection immediately after upgrading,
  // before the client's `open` handler runs): the client's `open` still fires
  // with readyState === OPEN(1) and `send` completes without throwing; the call
  // settles later via the `close` listener instead. No reachable real-world
  // server response can make `ws.send` throw at this call site, so the test below
  // documents the behavior rather than killing the mutant.
  test("ws.send in the open handler does not throw even when the server closes the connection immediately (documents L158/159 as equivalent)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          ws.close();
        },
        message() {},
      },
    });
    try {
      // If `ws.send` had thrown, this would reject via the catch's own error
      // instead of the close listener's "closed before a response" — observing
      // the latter is evidence `send` executed without throwing.
      await expect(wsRequest(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "closed before a response",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent close is an observable side effect", () => {
  test("wsRequestPersistent actually closes the socket before settling — the server sees a close (kills L198 BlockStatement -> '{}')", async () => {
    let serverSawClose = false;
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws, msg) {
          ws.send(`resp:${msg}`);
          // Deliberately never closes — only the client's own finish-triggered
          // `ws.close()` (via timeout) can make the server observe a close.
        },
        close() {
          serverSawClose = true;
        },
      },
    });
    try {
      const result = await wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 100, 1_000_000);
      expect(result).toBe("resp:hi");
      const deadline = Date.now() + 1000;
      while (!serverSawClose && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(serverSawClose).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent timeout with no message ever received", () => {
  test("rejects with the exact 'timeout' message when no message ever arrives before the deadline (kills L207 ConditionalExpression -> true + StringLiteral -> '')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message() {
          /* never sends */
        },
      },
    });
    try {
      await expect(wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 50, 1_000_000)).rejects.toThrow(
        "timeout",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent closes before any message", () => {
  test("rejects with the exact 'WebSocket closed before a response' message when the server closes without ever sending a message (kills L230 ConditionalExpression -> true + StringLiteral -> '')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message() {
          /* never sends */
        },
        open(ws) {
          ws.close();
        },
      },
    });
    try {
      await expect(wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "closed before a response",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent binary payload + cap boundary", () => {
  test("a non-string (binary) WS message is treated as an empty string, not passed through raw (kills L219 ConditionalExpression -> true + StringLiteral fallback -> 'Stryker was here!')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          ws.send(new Uint8Array([1, 2, 3, 4]));
          ws.close();
        },
        message() {},
      },
    });
    try {
      const result = await wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, 100);
      expect(result).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("resolves (does not reject) when a message's length is exactly maxBytes — boundary (kills L220 EqualityOperator > -> >=)", async () => {
    const N = 10;
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws) {
          ws.send("x".repeat(N));
          ws.close();
        },
      },
    });
    try {
      const result = await wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, N);
      expect(result).toBe("x".repeat(N));
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent cap-exceeded rejection (+ settled-guard reentrancy)", () => {
  // `finish()` called from the cap check invokes `ws.close()`, which — verified
  // empirically — synchronously re-enters the `close` event listener (and thus
  // `finish()` again) *before* the outer `finish()` call gets to invoke its own
  // callback. The `settled` guard (L195/196) is what makes the outer (cap)
  // call win instead of the reentrant close-triggered one; disabling either half
  // of that guard flips the observed rejection from the cap message to
  // "WebSocket closed before a response". This test's server deliberately never
  // closes the connection itself, so the only `close()` in play is the one
  // `finish` makes internally — exercising that reentrancy for real.
  test("rejects with the exact cap message even though closing the socket re-enters finish synchronously (kills L195 ConditionalExpression -> false, L196 BooleanLiteral -> false, L220 ConditionalExpression -> false, L220-223 BlockStatement -> '{}', L221 ArrowFunction -> undefined + StringLiteral -> '')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws) {
          ws.send("x".repeat(50)); // oversized; server never closes on its own
        },
      },
    });
    try {
      await expect(wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 500, 10)).rejects.toThrow(
        "MAX_RESPONSE_BYTES",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent real protocol error", () => {
  test("rejects with the exact 'WebSocket error' message on a real failed handshake (kills L228 StringLiteral x2 + ArrowFunction x2)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 400 }),
    });
    try {
      await expect(wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "WebSocket error",
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("backends — wsRequestPersistent send() cannot throw in practice (equivalent mutants)", () => {
  // NOTE — equivalent mutant, verified empirically: L214/215 (BlockStatement ->
  // '{}' on the `catch (e)` body, and the ArrowFunction inside it) — identical
  // reasoning to wsRequest's L158/159 above: `ws.send` cannot throw
  // synchronously from inside a real client's own `open` handler (readyState is
  // guaranteed OPEN throughout that synchronous call), so this catch body is
  // unreachable via any real WS server interaction. Confirmed with the same
  // live experiment as above (server closes immediately after upgrading).
  test("ws.send in the open handler does not throw even when the server closes the connection immediately (documents L214/215 as equivalent)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          ws.close();
        },
        message() {},
      },
    });
    try {
      await expect(wsRequestPersistent(`ws://localhost:${server.port}`, "hi", 2000, 1_000_000)).rejects.toThrow(
        "closed before a response",
      );
    } finally {
      server.stop(true);
    }
  });
});
