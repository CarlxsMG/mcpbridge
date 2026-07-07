/**
 * Extra backends — GraphQL (args wrapped as { query, variables }) and WebSocket
 * (ephemeral request/response), both as per-tool config on a REST client.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { proxyToolCall } from "../../proxy/proxy.js";
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
  test("getToolGraphql / getGraphqlForClient map enabled=false (kills L28/L37)", async () => {
    await reg();
    setToolGraphql(CLIENT, "gql", { enabled: false, query: "{y}" });
    expect(getToolGraphql(CLIENT, "gql")?.enabled).toBe(false);
    expect(getGraphqlForClient(CLIENT)).toEqual({ gql: { enabled: false, query: "{y}" } });
  });

  test("getToolWs / getWsForClient map enabled=false + persistent=false (kills L75/L93/L96)", async () => {
    await reg();
    (config as Record<string, unknown>).allowPrivateIps = true;
    await setToolWs(CLIENT, "wst", { enabled: false, wsUrl: "ws://5.6.7.8", persistent: false });
    const ws = getToolWs(CLIENT, "wst");
    expect(ws?.enabled).toBe(false);
    expect(ws?.persistent).toBe(false);
    expect(getWsForClient(CLIENT).wst).toMatchObject({ enabled: false, persistent: false, resolvedIp: "5.6.7.8" });
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
