import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { registry } from "../registry.js";
import type { RestToolDefinition } from "../types.js";
import * as mcpServerMod from "../mcp-server.js";
import * as loggerMod from "../../logger.js";

// ===========================================================================
// Stryker mutation backstop — CLUSTER T3 (src/mcp/transports.ts,
// handleStreamablePost()):
//   (1) the final "session id present, syntactically valid, but genuinely
//       unknown" 404 branch (source ~L184-190 — reached when the caller
//       supplies a well-formed UUID that was never issued, so it is neither
//       an in-flight session (L116's has()-true branch) nor a brand-new
//       request (L131's !sessionId branch)), and
//   (2) the entire catch-block error path (source ~L192-209): the
//       `log("error", ...)` call, the `{ sessionId, err }` meta object, the
//       `transport && !transportInserted` reservation-release guard and its
//       `Math.max(0, activeSessionCount - 1)` arithmetic, the
//       `res.headersSent` double-send guard, the typeof-narrowed `id` in the
//       500 body, and the outer `{ jsonrpc: "2.0", error: { code: -32603,
//       message: "Internal error" }, id }` shape.
//
// Per-test comments cite the exact line:column + mutator + replacement they
// target, matching the convention in e.g. registry-persistence-mutation.test.ts.
// Line numbers are approximate (source may have drifted a line or two since
// this cluster was scoped) but the code shape they refer to is unambiguous.
//
// THROW-TRIGGER TECHNIQUE (real HTTP surface, no modification of
// transports.ts): the SDK's own StreamableHTTPServerTransport /
// WebStandardStreamableHTTPServerTransport wraps essentially every failure
// mode internally (JSON parse errors, JSON-RPC schema errors, missing
// Accept/Content-Type headers, DNS-rebinding checks, etc.) in its OWN
// try/catch and returns a Response object rather than throwing back out to
// `transport.handleRequest(...)` — confirmed by reading
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
// (handlePostRequest's outer try/catch always returns
// `createJsonErrorResponse(...)`) and node_modules/@hono/node-server's
// getRequestListener (which likewise catches and converts every internal
// failure into a Response, never rethrowing to the awaited caller). So a
// malformed JSON-RPC body alone can NEVER reach handleStreamablePost's own
// catch block — it is fully absorbed by the SDK first.
//
// The one genuinely reachable, *legitimate* way to make handleStreamablePost
// itself throw is a failing DEPENDENCY call it does synchronously/awaited
// inside the try, before the SDK ever gets involved:
//   - `createMcpServer(scope)` (L170, new-session branch) — spied via
//     `spyOn(mcpServerMod, "createMcpServer")` (same technique the existing
//     registration-mutation-rg* suite already uses for
//     validateBackendUrl/discoverToolsFromMcpServer: spying a named export on
//     its own module namespace object patches the live binding every other
//     importer — including transports.ts — reads from).
//   - `registry.getClient(scope.name)` inside `scopeNotFound(scope)` (L132,
//     BEFORE the transport is even constructed) — spied directly on the
//     shared `registry` singleton instance (no namespace indirection needed;
//     it's a plain method on an object all modules share the same reference
//     to).
// Both are real dependency calls a legitimate caller can observably fail
// (e.g. a corrupt tool-schema during server construction, or a transient
// registry/db hiccup during the existence check) — this is not reaching into
// transports.ts's private state, just making its real collaborators fail the
// way they can in production.
//
// These two trigger points land in different places relative to
// `transport`/`transportInserted`, which is what lets us kill BOTH
// directions of the `transport && !transportInserted` mutants:
//   - createMcpServer throws AFTER `transport = new StreamableHTTPServer...`
//     (L155) but BEFORE `transportInserted = true` (L181) → real condition
//     is TRUE (cleanup must run, count must un-leak).
//   - registry.getClient throws BEFORE transport is ever assigned → real
//     condition is FALSE (`transport` is `undefined`) — if a mutant forces
//     the guard to `true` anyway, `transport.close()` on `undefined` throws
//     a bare TypeError that escapes the catch block entirely (Express 5
//     forwards it to its own default error handler), which is trivially
//     distinguishable from our controlled 500 JSON-RPC envelope.
//
// LIKELY-EQUIVALENT / UNREACHABLE VIA PUBLIC HTTP SURFACE (documented per
// the task brief rather than silently dropped):
//   - 202:9-202:24 ConditionalExpression, the "force `if (res.headersSent)
//     return` to `false`" direction. This is only observable when
//     `res.headersSent` is genuinely `true` at throw time, i.e. the SDK
//     partially wrote a response and *then* threw. Per the trace above, the
//     SDK never does this on any realistic input — its own handlePostRequest
//     catches everything before `await handler(req, res)` returns control to
//     us, and outside that, nothing in handleStreamablePost writes to `res`
//     before the point where our two triggers throw (both fire before
//     `transport.handleRequest` is ever called). The "force to `true`"
//     direction (drop the response) unconditionally IS killed below, since
//     our reachable triggers always have `headersSent === false` and we
//     assert a real body arrives.
//   - Math.max(0, activeSessionCount - 1)'s "drop Math.max, keep the bare
//     subtraction" shape: only distinguishable from correct behavior when
//     the clamp actually engages (count would go negative), which cannot
//     happen on this exact decrement (we always increment-then-decrement by
//     exactly one around the same request, so the pre-decrement value is
//     provably >= 1). Forcing activeSessionCount negative first would
//     require exploiting a DIFFERENT bug and isn't a legitimate trigger for
//     THIS cluster's mutants, so this specific sub-mutant is left
//     undistinguished by design; the ArithmeticOperator (`-1` -> `+1`) and
//     the guard-condition mutants around it are fully killed below.
// ===========================================================================

let baseUrl = "";
let activeServer: Server | null = null;
let cleanupFn: (() => void) | null = null;

async function startApp(): Promise<void> {
  const { setupTransports } = await import("../../mcp/transports.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  cleanupFn = setupTransports(app);

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopApp(): Promise<void> {
  if (cleanupFn) cleanupFn();
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "probe tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Real (non-mocked) initialize handshake — just enough to get a live session id and bump activeSessionCount. */
async function establishRealSession(path: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3", version: "1.0" } },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  expect(res.status).toBe(200);
  expect(sessionId).not.toBeNull();
  return sessionId!;
}

/** POSTs a brand-new-session request (no mcp-session-id header) with a given body.id, while createMcpServer is
 *  made to throw for exactly this one call. Returns the parsed JSON-RPC error response. */
async function postNewSessionWithFailingCreate(
  path: string,
  bodyId: unknown,
  errMessage = "t3-boom",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const createSpy = spyOn(mcpServerMod, "createMcpServer").mockImplementationOnce(() => {
    throw new Error(errMessage);
  });
  try {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method: "initialize" };
    if (bodyId !== undefined) payload.id = bodyId;
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    createSpy.mockRestore();
  }
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopApp();
});

// ---------------------------------------------------------------------------
// GROUP 1 — the final "else" 404 branch: session id present, valid UUID
// format, but never issued (not in `streamableSessions`).
// Targets: 186:28-190:8 (whole else-branch body), 188:16-188:73 (error
// object literal), 188:24-188:30 (-32000 code literal), 188:41-188:71
// ("Session not found or expired" message literal), 189:13-189:33
// (`id: req.body?.id ?? null`), 189:13-189:25 (the `req.body?.id ?? null`
// sub-expression / optional-chaining mutants).
// ---------------------------------------------------------------------------

describe("handleStreamablePost — unknown-but-valid-format session (final else-branch 404)", () => {
  test("a syntactically valid but never-issued session id echoes the caller's numeric request id, not null (kills ?? -> && and the id ?? null -> id mutants)", async () => {
    await startApp();
    await reg("t3-client");

    const res = await fetch(`${baseUrl}/mcp/t3-client`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 55 }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: number };
    // Exact full-shape assertion — kills the whole error-object literal
    // (188:16-188:73), the -32000 code literal, and the message string
    // literal in one stroke.
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found or expired" },
      id: 55,
    });
  });

  test("with no id in the request body, the response echoes id: null (present key, not omitted) — kills id ?? null -> id ?? undefined-shaped mutants and the && swap for the absent-id arm", async () => {
    await startApp();
    await reg("t3-client");

    const res = await fetch(`${baseUrl}/mcp/t3-client`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    // toHaveProperty with an explicit value requires the key to be PRESENT
    // and equal to null — a `&&` mutant (undefined && null -> undefined,
    // which JSON.stringify drops entirely) would make this key vanish and
    // fail this exact assertion, unlike a looser `body.id == null` check.
    expect(body).toHaveProperty("id", null);
    expect(body.error).toEqual({ code: -32000, message: "Session not found or expired" });
  });

  // 189:13-189:25 OptionalChaining [Survived] "req.body?.id" -> "req.body.id".
  // The "no id in body" test above still sends a real JSON object (just
  // without an "id" key), so req.body is never actually undefined there and
  // doesn't distinguish this mutant. Only a request with NO content-type (so
  // express.json() never runs and req.body stays undefined) does: the real
  // code's "?." safely yields null, while the mutant's bare "req.body.id"
  // throws synchronously and turns this into a 500 instead of a 404.
  test("unknown session id with NO request body at all (no content-type) still returns a clean 404 with id: null, not a 500 crash", async () => {
    await startApp();
    await reg("t3-client-nobody");

    const res = await fetch(`${baseUrl}/mcp/t3-client-nobody`, {
      method: "POST",
      headers: { "mcp-session-id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found or expired" },
      id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// GROUP 2 — catch block, triggered via createMcpServer() throwing between
// transport creation (L155) and transportInserted=true (L181).
// ---------------------------------------------------------------------------

describe("handleStreamablePost — catch block: createMcpServer() throws mid-session-creation", () => {
  beforeEach(async () => {
    await startApp();
    await reg("t3-client");
  });

  // 192:17-209:4 BlockStatement [Survived] (emptying the whole catch means
  // no log call and no response at all) — killed as a side effect of every
  // assertion below expecting a real logged call and a real 500 body.
  // 193:9-193:16 StringLiteral ("error" level), 193:18-193:66 StringLiteral
  // (the "POST handler failed (scope=...)" message text — the real source
  // builds this with a template literal, but is otherwise the same dynamic
  // string), 193:68-196:6 ObjectLiteral (the `{ sessionId, err }` meta
  // object).
  test("logs level 'error', a message naming the failure and the scope, and a meta object carrying exactly {sessionId, err}", async () => {
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const { status } = await postNewSessionWithFailingCreate("/mcp/t3-client", 1, "t3-log-boom");
      expect(status).toBe(500);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = logSpy.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(level).toBe("error");
      expect(typeof message).toBe("string");
      expect(message.includes("POST handler failed")).toBe(true);
      // scopeKey({kind:"client", name:"t3-client"}) === "client:t3-client"
      expect(message.includes("client:t3-client")).toBe(true);

      // Exact key set — an ObjectLiteral->{} mutant would drop both keys;
      // this catches that AND any single-key drop.
      expect(Object.keys(meta).sort()).toEqual(["err", "sessionId"]);
      // This POST never sent an mcp-session-id header (new-session branch
      // is the ONLY branch that can reach L170's createMcpServer call), so
      // the real, correct value really is undefined — asserted via `in`
      // (property present) rather than a loose equality so an
      // ObjectLiteral->{} mutant (key entirely absent) still fails this.
      expect("sessionId" in meta).toBe(true);
      expect(meta.sessionId).toBeUndefined();
      // The meta flattens the Error to { message, stack, name } rather than
      // logging the raw Error — a raw Error serializes to `{}` under the JSON
      // logger (message/stack/name are non-enumerable), so the handler mirrors
      // server.ts / system-tools.ts. Asserting the flattened shape here also
      // backstops against a regression to the raw-Error form.
      expect(meta.err).not.toBeInstanceOf(Error);
      const flatErr = meta.err as { message: string; stack: string; name: string };
      expect(flatErr.message).toBe("t3-log-boom");
      expect(flatErr.name).toBe("Error");
      expect(typeof flatErr.stack).toBe("string");
    } finally {
      logSpy.mockRestore();
    }
  });

  // 197:9-197:40 (2x ConditionalExpression: force `if (transport &&
  // !transportInserted)` to always-true / always-false) and
  // 197:22-197:40 (negation removal on `!transportInserted`) —
  // the "always false" and negation-removal directions are both killed
  // here: in this scenario the real condition IS true (transport was
  // constructed at L155, transportInserted never reached true), so forcing
  // it false (or defeating it via the negation removal, which makes the
  // whole expression false too since transportInserted is false) means the
  // reservation is never released and activeSessionCount stays leaked.
  // The "always true" direction is killed in the sibling describe block
  // below (registry.getClient() throw, where transport is genuinely
  // undefined).
  // 199:28-199:63 (Math.max(0, activeSessionCount - 1)) and 199:40-199:62
  // (ArithmeticOperator on `- 1`) — asserted via an exact before/after
  // count-delta against a REAL, independently-established session, so the
  // baseline is never 0 and an ArithmeticOperator flip (`-1` -> `+1`) is
  // observable as a +2 drift rather than being masked by clamping at zero.
  test("does not leak the session-count reservation after a mid-creation failure, and decrements by exactly one", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");

    // One real, successfully-established session first, so the baseline
    // count is guaranteed >= 1 (not 0) before the failing request below.
    await establishRealSession("/mcp/t3-client");
    const baseline = getActiveSessionCount();
    expect(baseline).toBeGreaterThanOrEqual(1);

    const { status } = await postNewSessionWithFailingCreate("/mcp/t3-client", 2, "t3-leak-boom");
    expect(status).toBe(500);

    // Exactly back to baseline: not leaked (+1), not over-decremented (-1
    // below baseline), not clobbered to 0 by a mutant that drops the real
    // count entirely.
    expect(getActiveSessionCount()).toBe(baseline);
  });

  // 202:9-202:24 ConditionalExpression on `if (res.headersSent) return` —
  // the "force to true" (drop the response unconditionally) direction: in
  // this reachable scenario headersSent is genuinely false, so a
  // force-to-true mutant would swallow the response entirely and this
  // `await res.json()` would never resolve with our envelope (fetch itself
  // would still resolve since nothing aborts the connection... but no body
  // would ever be written, so parsing it as our expected JSON-RPC shape
  // fails). The "force to false" direction is documented as
  // likely-unreachable in the file header.
  // 203:16-203:84 (typeof req.body?.id === "string" || typeof
  // req.body?.id === "number" ? req.body.id : null) and its Equality/
  // OptionalChaining/StringLiteral children, plus 204:26-208:6,
  // 205:16-205:21 (jsonrpc "2.0"), 206:14-206:57 (whole error object),
  // 206:22-206:28 (-32603 code), 206:39-206:55 ("Internal error" message)
  // — the string/number/other trio, each also asserting the full outer
  // shape.
  test("the 500 body's id narrows correctly: a string id is echoed verbatim", async () => {
    const { status, body } = await postNewSessionWithFailingCreate("/mcp/t3-client", "abc-string-id");
    expect(status).toBe(500);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: "abc-string-id",
    });
  });

  test("the 500 body's id narrows correctly: a numeric id is echoed verbatim", async () => {
    const { status, body } = await postNewSessionWithFailingCreate("/mcp/t3-client", 99);
    expect(status).toBe(500);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: 99,
    });
  });

  test("the 500 body's id narrows correctly: a non-string/number id (boolean) becomes null, not echoed", async () => {
    const { status, body } = await postNewSessionWithFailingCreate("/mcp/t3-client", true);
    expect(status).toBe(500);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: null,
    });
  });

  test("the 500 body's id narrows correctly: an object id also becomes null, not echoed", async () => {
    const { status, body } = await postNewSessionWithFailingCreate("/mcp/t3-client", { nested: true });
    expect(status).toBe(500);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: null,
    });
  });

  // 203:23-203:35 and 203:59-203:71 OptionalChaining [Survived]
  // "req.body?.id" -> "req.body.id" — both live INSIDE the typeof checks of
  // the id-narrowing ternary itself (`typeof req.body?.id === "string" ||
  // typeof req.body?.id === "number" ? req.body.id : null`). Every trigger
  // above sends a real JSON body, so req.body is always a defined object and
  // these never differ (typeof undefined-vs-missing-key is the same either
  // way once req.body itself exists). Only when req.body is truly undefined
  // (no content-type sent at all) does stripping "?." inside "typeof
  // req.body?.id" matter: the real code evaluates "typeof undefined" =
  // "undefined" safely; the mutant evaluates "req.body.id" directly, which
  // throws (Cannot read properties of undefined) — INSIDE the catch block's
  // own body, with no surrounding try/catch, so the error escapes
  // handleStreamablePost's async function entirely. Express 5 forwards that
  // rejected promise to its own default error handler instead of our
  // controlled JSON-RPC envelope, which is trivially distinguishable: the
  // response is no longer valid JSON matching our exact shape.
  test("catch-block id-narrowing survives a request with NO body at all — still the clean JSON-RPC 500 envelope, not an uncaught crash", async () => {
    const createSpy = spyOn(mcpServerMod, "createMcpServer").mockImplementationOnce(() => {
      throw new Error("t3-nobody-boom");
    });
    try {
      const res = await fetch(`${baseUrl}/mcp/t3-client`, { method: "POST" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    } finally {
      createSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — catch block, triggered via registry.getClient() throwing inside
// scopeNotFound() at L132, i.e. BEFORE `transport` is ever assigned (L155).
// This is the complementary trigger to GROUP 2: here the real
// `transport && !transportInserted` condition is FALSE (`transport` is
// `undefined`), which is what's needed to kill the LogicalOperator (&& ->
// ||) mutant and the "force condition to always-true" ConditionalExpression
// mutant that GROUP 2 structurally cannot reach.
// ---------------------------------------------------------------------------

describe("handleStreamablePost — catch block: registry.getClient() throws before transport exists", () => {
  test("500 is still returned correctly (transport stays undefined, cleanup guard correctly skipped, no crash) and the count is untouched", async () => {
    await startApp();
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const baselineBefore = getActiveSessionCount();

    const getClientSpy = spyOn(registry, "getClient").mockImplementationOnce(() => {
      throw new Error("t3-registry-boom");
    });
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/mcp/t3-ghost`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 66 }),
      });

      // If a mutant forces `if (transport && !transportInserted)` to always
      // true here, `transport` is `undefined` and `await transport.close()`
      // throws a bare TypeError that escapes handleStreamablePost entirely
      // (nothing downstream catches it), so Express's own default error
      // handler responds instead of our controlled JSON-RPC envelope —
      // parsing it as our exact expected shape below fails in that case.
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: 66,
      });

      // scopeNotFound() throwing happens BEFORE the maxSessions check and
      // BEFORE `activeSessionCount++` (source ~L132, well ahead of L144-152),
      // so the count must be completely untouched by this failure — neither
      // incremented-and-not-released, nor (if a mutant wrongly entered the
      // cleanup branch) decremented below its true baseline.
      expect(getActiveSessionCount()).toBe(baselineBefore);

      // Same {sessionId, err} shape assertion as GROUP 2, on the second
      // legitimate throw site, for extra confidence in 193:68-196:6.
      expect(logSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = logSpy.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(Object.keys(meta).sort()).toEqual(["err", "sessionId"]);
      expect(meta.sessionId).toBeUndefined();
      expect((meta.err as Error).message).toBe("t3-registry-boom");
    } finally {
      logSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  });
});
