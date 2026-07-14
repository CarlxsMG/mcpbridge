/**
 * Stryker mutation-testing backstop for src/mcp/transports.ts — CLUSTER T2:
 * handleStreamablePost's session-ID guard rejection, existing-session-reuse
 * vs. unknown-session branch selection, scope-mismatch 404 body, max-sessions
 * 503 body, and the new-session creation success path (onclose, connect,
 * storage). Source lines ~102-183 (see src/mcp/transports.ts; line numbers
 * below match that file as of this writing and may drift by a line or two).
 *
 * None of handleStreamablePost/Get/Delete/scopeNotFound/isValidSessionId/
 * scopeKey/touchSession/startSessionCleanup are exported — every test here
 * drives them through real HTTP requests against a real Express app wired
 * via the exported setupTransports(app), reusing the app-boot idiom from
 * transports.test.ts (startApp/stopServer) and the real MCP handshake idiom
 * from transports-sharded.test.ts (initSession/toolsList/reg). Each
 * describe/test cites the exact line:col + mutator + replacement it targets,
 * per the house convention (see registry-persistence-mutation.test.ts).
 *
 * ---------------------------------------------------------------------------
 * EQUIVALENT-MUTANT NOTE (read before judging survivors after a Stryker run)
 * ---------------------------------------------------------------------------
 * Two mutants in this cluster were investigated in depth, including hand-
 * mutating a throwaway local copy of transports.ts and driving it with the
 * exact scenario the cluster brief suggested, to see the real HTTP response
 * byte-for-byte:
 *
 * - 116:9-116:55 LogicalOperator ("sessionId && streamableSessions.has(id)"
 *   -> "sessionId || streamableSessions.has(id)"): the suggested kill is "POST
 *   with a syntactically valid but never-issued session id must return 404,
 *   not 500". Empirically this does NOT distinguish the mutant: under the
 *   mutant, a truthy-but-unknown sessionId still enters the `if` branch, but
 *   the very next line (L117, `sessionScope.get(sessionId) !==
 *   scopeKey(scope)`) is *also* false-for-real (an unregistered session has
 *   no sessionScope entry either, so the comparison is `undefined !==
 *   "<scope>"`, always true) — so the mutant falls into the scope-mismatch
 *   404 branch (L120-125), which the source's own comment notes is
 *   deliberately "the same 404 shape as unknown session" (L118-119). Verified
 *   by hand-mutating a throwaway copy of the file and driving it with
 *   `POST /mcp/<client>` + a fresh UUID + `id: 77`: both the real file and
 *   the hand-mutated copy return status 404 with the byte-identical body
 *   `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session not found or
 *   expired"},"id":77}`. The only way to reach the `.get(sessionId)!`
 *   non-null-assertion crash the mutant would need to actually diverge (a
 *   session present in `sessionScope` but absent from `streamableSessions`)
 *   requires desyncing those two maps, which is unreachable through the
 *   public HTTP surface: every insertion site (L177-183) and all four
 *   deletion sites (TTL cleanup L74-75, onclose L163-165, DELETE handler
 *   L262-263, graceful-shutdown cleanup L353-354) mutate both maps together,
 *   in the same tick, with no `await` between them. The test below is kept
 *   anyway (it is exactly the scenario the cluster brief specifies, and it
 *   *does* correctly kill mutant 131 in the same request — see next bullet —
 *   plus it is valid regression coverage of the real 404-not-500 contract),
 *   but readers should not expect it to flip 116 from "survived" to "killed".
 *
 * - 177:11-177:30 ConditionalExpression ("if (transport.sessionId)" -> "if
 *   (true)"): investigated by sending a malformed `initialize` call (valid
 *   JSON-RPC envelope, method "initialize", but missing the required
 *   `params`) and inspecting both `res.headers.get("mcp-session-id")` and
 *   `getActiveSessionCount()` before/after, confirmed against the real SDK
 *   source (node_modules/@modelcontextprotocol/sdk .../webStandardStreamableHttp.js):
 *   the SDK only assigns `this.sessionId` inside its own `isInitializeRequest`
 *   branch (which requires the params to validate), so a malformed initialize
 *   really does leave `transport.sessionId` `undefined` without throwing —
 *   confirmed by the response headers carrying no `mcp-session-id` in either
 *   version. But this happens *after* `transport.handleRequest(...)` (L174)
 *   has already fully written the response, so the branch at L177 can only
 *   affect side effects the client can never subsequently observe: it would
 *   insert a phantom entry into `streamableSessions`/`sessionScope`/
 *   `sessionActivity` keyed by the literal JS value `undefined` — but every
 *   later request's `sessionId` is either a validated string or exactly
 *   `undefined` (never sent as a header value), and both `handleStreamablePost`'s
 *   `sessionId && ...` / `!sessionId` guards and `handleStreamableGet`/
 *   `handleStreamableDelete`'s `isValidSessionId` guard short-circuit on a
 *   `sessionId` of `undefined` *before* it is ever used as a map key — so the
 *   phantom entry can never be looked up. `activeSessionCount` doesn't move
 *   either way (it was already reserved at L152, unconditionally, before this
 *   branch). The malformed-initialize test below is kept as valid regression
 *   coverage of real (if slightly leaky-looking) behavior, but is not
 *   expected to kill 177 for the same "no future request can observe the
 *   difference" reason.
 *
 * 181:29-181:33 BooleanLiteral (`transportInserted = true` -> `= false`) is
 * deliberately NOT tested here: `transportInserted` is only ever *read* in
 * the catch block (L197), which this cluster's happy/expected-error paths
 * never enter. Per the cluster brief, that flag is more naturally killed by
 * an error-path test in cluster T3 (which owns the catch block).
 */

import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// App factory — mirrors transports.test.ts / transports-sharded.test.ts.
// ---------------------------------------------------------------------------

let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<() => void> {
  const { setupTransports } = await import("../../mcp/transports.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  const cleanup = setupTransports(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve(cleanup);
    });
    srv.on("error", reject);
  });
}

function stopServer(cleanup: () => void): Promise<void> {
  cleanup();
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

/** Real MCP initialize handshake (initialize -> notifications/initialized). Returns the session id, or null. */
async function initSession(path: string, extraHeaders: Record<string, string> = {}): Promise<string | null> {
  const initRes = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) return null;

  await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
}

async function cleanupClients(): Promise<void> {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
}

// ---------------------------------------------------------------------------
// 110:53-110:83 StringLiteral [Survived] — handleStreamablePost's own copy of
// the 400 INVALID_SESSION_ID message text (a separate literal from GET/DELETE's
// copies, out of scope for this file).
// ---------------------------------------------------------------------------

describe("handleStreamablePost — 400 INVALID_SESSION_ID exact message (L110)", () => {
  test("POST with a malformed mcp-session-id returns the exact message text, not just status 400", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp/some-client`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "not-a-uuid",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_SESSION_ID");
      expect(body.error.message).toBe("Session ID must be a UUID v4");
    } finally {
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// 116:9-116:55 LogicalOperator [Survived, see equivalence note in header] and
// 131:16-131:26 ConditionalExpression [Survived] — a syntactically valid but
// never-issued session id must fall through to the final "session not found
// or expired" branch (L184-191): NOT the existing-session branch (would crash
// -> 500 under 116's mutant, though empirically the crash is masked — see
// header note) and NOT the new-session branch (would silently reserve a slot
// and attempt to run "tools/list" as if it were an initialize -> under 131's
// mutant this diverts to an entirely different response shape/status and
// leaks an activeSessionCount reservation).
// ---------------------------------------------------------------------------

describe("handleStreamablePost — unknown-but-well-formed session id (L116, L131)", () => {
  test("POST with a fresh valid-format session id never obtained via handshake: 404 (not 500/other), no new session started, count unchanged, id echoed", async () => {
    await reg("t2-unknown-session-client");
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const cleanup = await startApp();
    try {
      const before = getActiveSessionCount();
      const res = await fetch(`${baseUrl}/mcp/t2-unknown-session-client`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 77 }),
      });

      // L131: must NOT have entered the "new session" branch — no session
      // was silently created and no reservation was taken.
      expect(res.headers.get("mcp-session-id")).toBeNull();
      expect(getActiveSessionCount()).toBe(before);

      // L116 (and, redundantly, L131 again): must land in a real 404, and
      // the body must be the exact JSON-RPC error shape with the id echoed.
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: 77,
      });
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });
});

// ---------------------------------------------------------------------------
// 121:20-121:25, 122:18-122:75, 122:26-122:32, 122:43-122:73, 123:15-123:35,
// 123:15-123:27 — the scope-mismatch 404 body (a session id that IS
// registered, but bound to a DIFFERENT scope than the URL it's replayed
// against). transports-sharded.test.ts's confused-deputy tests check only
// res.status === 404; this asserts the full body, including the id-echo
// technique (a distinctive id in the request proves `req.body?.id ?? null`
// is not being wrongly forced to `null` for a truthy id, and that the
// optional-chaining itself is intact).
// ---------------------------------------------------------------------------

describe("handleStreamablePost — scope-mismatch 404 body (L121-123)", () => {
  test("a session bound to client-a, replayed against client-b's URL, returns the exact JSON-RPC 404 body with the request id echoed", async () => {
    await reg("t2-scope-a");
    await reg("t2-scope-b");
    const cleanup = await startApp();
    try {
      const sessionId = await initSession("/mcp/t2-scope-a");
      expect(sessionId).not.toBeNull();

      const res = await fetch(`${baseUrl}/mcp/t2-scope-b`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 77 }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: 77,
      });
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });

  test("same scope-mismatch, but the request carries NO id — must echo null, not omit the field or throw", async () => {
    await reg("t2-scope-c");
    await reg("t2-scope-d");
    const cleanup = await startApp();
    try {
      const sessionId = await initSession("/mcp/t2-scope-c");
      expect(sessionId).not.toBeNull();

      const res = await fetch(`${baseUrl}/mcp/t2-scope-d`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: null,
      });
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });

  // 123:15-123:27 OptionalChaining [Survived] "req.body?.id" -> "req.body.id".
  // A missing `id` KEY (the test above) doesn't distinguish this — req.body
  // is still a real object either way. Only when req.body ITSELF is
  // undefined does stripping the "?." matter: no content-type / no body at
  // all means express.json() never runs, so req.body stays undefined. Under
  // the real code, "req.body?.id ?? null" safely yields null; under the
  // mutant, "req.body.id" throws synchronously (Cannot read properties of
  // undefined), which escapes to the outer catch and turns this into a 500
  // instead of the correct 404.
  test("scope-mismatch with NO request body at all (no content-type) still returns a clean 404 with id: null, not a 500 crash", async () => {
    await reg("t2-scope-e");
    await reg("t2-scope-f");
    const cleanup = await startApp();
    try {
      const sessionId = await initSession("/mcp/t2-scope-e");
      expect(sessionId).not.toBeNull();

      const res = await fetch(`${baseUrl}/mcp/t2-scope-f`, {
        method: "POST",
        headers: { "mcp-session-id": sessionId! },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found or expired" },
        id: null,
      });
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });
});

// ---------------------------------------------------------------------------
// 135:52-135:70 and 136:52-136:70 StringLiteral [Survived] — CLIENT_NOT_FOUND
// / BUNDLE_NOT_FOUND messages, reached via a brand-new-session POST (no
// mcp-session-id) hitting scopeNotFound().
// ---------------------------------------------------------------------------

describe("handleStreamablePost — new-session scopeNotFound() 404 exact messages (L135, L136)", () => {
  test("POST /mcp/:clientName (no session) for an unregistered client returns the exact 'Client not found' message", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp/t2-nonexistent-client`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error.message).toBe("Client not found");
    } finally {
      await stopServer(cleanup);
    }
  });

  test("POST /mcp-custom/:bundleName (no session) for an unregistered bundle returns the exact 'Bundle not found' message", async () => {
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp-custom/t2-nonexistent-bundle`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
      expect(body.error.message).toBe("Bundle not found");
    } finally {
      await stopServer(cleanup);
    }
  });
});

// ---------------------------------------------------------------------------
// 146:20-146:25, 147:18-147:78, 147:26-147:32, 147:43-147:76, 148:15-148:35,
// 148:15-148:27 — the maxSessions-cap 503 body. transports.test.ts's existing
// "respects maxSessions cap" test checks only res.status === 503; this adds
// the id-echo technique plus the exact code/message.
// ---------------------------------------------------------------------------

describe("handleStreamablePost — maxSessions cap 503 exact body (L146-148)", () => {
  const ROOT_KEY = "t2-root-admin-key";

  test("POST /mcp new-session at capacity returns the exact JSON-RPC 503 body with the request id echoed", async () => {
    await withConfig({ adminApiKeys: [ROOT_KEY], maxSessions: 0 }, async () => {
      const cleanup = await startApp();
      try {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${ROOT_KEY}` },
          body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 88 }),
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Server at capacity, retry later" },
          id: 88,
        });
      } finally {
        await stopServer(cleanup);
      }
    });
  });

  // 148:15-148:27 OptionalChaining [Survived] "req.body?.id" -> "req.body.id"
  // — same class of gap as 123 above (see that test's comment): needs
  // req.body to be genuinely undefined (no content-type sent at all), not
  // merely missing an "id" key, to distinguish the mutant.
  test("POST /mcp new-session at capacity with NO request body at all still returns a clean 503 with id: null, not a 500 crash", async () => {
    await withConfig({ adminApiKeys: [ROOT_KEY], maxSessions: 0 }, async () => {
      const cleanup = await startApp();
      try {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ROOT_KEY}` },
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body).toEqual({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Server at capacity, retry later" },
          id: null,
        });
      } finally {
        await stopServer(cleanup);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 152:7-152:27 UpdateOperator [Survived] "activeSessionCount--" (flipped from
// ++), immediately before creating a new session.
// ---------------------------------------------------------------------------

describe("handleStreamablePost — new-session reservation increments the counter (L152)", () => {
  test("a successful new-session handshake increases getActiveSessionCount() by exactly 1", async () => {
    await reg("t2-counter-client");
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const cleanup = await startApp();
    try {
      const before = getActiveSessionCount();
      const sessionId = await initSession("/mcp/t2-counter-client");
      expect(sessionId).not.toBeNull();
      expect(getActiveSessionCount()).toBe(before + 1);
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });
});

// ---------------------------------------------------------------------------
// The transport.onclose handler installed during new-session creation (~L160)
// and releaseSession()'s decrement, exercised end-to-end via DELETE.
//
// A DELETE fires onclose synchronously inside the awaited
// `transport.handleRequest(req, res)` — the SDK's handleDeleteRequest calls
// `this.close()`, which invokes `this.onclose?.()` — and then
// handleStreamableDelete's own explicit releaseSession runs. Both call
// releaseSession, but it decrements ONLY when it is the call that actually
// removed the session from the map, so DELETE-ing ONE of two independent
// sessions drops activeSessionCount by exactly ONE (the former double-decrement
// bug is fixed), and the untouched session stays fully live — proving the `sid`
// resolved inside onclose is that session's own id (via
// streamableSessionIdByTransport) and doesn't leak across transports. A flipped
// `sid !== undefined` guard, a negated decrement, or a broken `if (removed)`
// gate all diverge the delta or session-B liveness from what the real file
// produces.
//
// Note: because onclose and the explicit DELETE path are now idempotently
// redundant, an "onclose body emptied" mutant no longer changes the DELETE
// delta (the explicit release covers it) — that mutant only manifests on the
// pure client-disconnect path (session lingers until the TTL sweep), which is
// not deterministically drivable through the HTTP surface, consistent with this
// file's other equivalence notes.
// ---------------------------------------------------------------------------

describe("transport.onclose + releaseSession — reachable via DELETE, single idempotent release (~L160)", () => {
  test("DELETE-ing one of two active sessions decrements activeSessionCount by exactly 1 (onclose + the explicit release are idempotently redundant, not additive)", async () => {
    await reg("t2-onclose-a");
    await reg("t2-onclose-b");
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    const cleanup = await startApp();
    try {
      const beforeHandshakes = getActiveSessionCount();
      const sessionA = await initSession("/mcp/t2-onclose-a");
      const sessionB = await initSession("/mcp/t2-onclose-b");
      expect(sessionA).not.toBeNull();
      expect(sessionB).not.toBeNull();
      const afterHandshakes = getActiveSessionCount();
      expect(afterHandshakes).toBe(beforeHandshakes + 2);

      const delRes = await fetch(`${baseUrl}/mcp/t2-onclose-a`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionA! },
      });
      expect(delRes.status).toBe(200);

      const afterDelete = getActiveSessionCount();
      expect(afterHandshakes - afterDelete).toBe(1);

      // Session B (never touched) must be completely unaffected by A's
      // onclose/cleanup running — proves the `sid` resolved inside onclose
      // really is A's own session id (via streamableSessionIdByTransport),
      // not something that leaks across transports.
      const stillWorks = await fetch(`${baseUrl}/mcp/t2-onclose-b`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionB!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 5 }),
      });
      expect(stillWorks.status).toBe(200);
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });
});

// ---------------------------------------------------------------------------
// 177:11-177:30 ConditionalExpression [Survived, see equivalence note in
// header] "if (transport.sessionId)" forced true.
// ---------------------------------------------------------------------------

describe("handleStreamablePost — new-session creation when initialize fails validation (L177)", () => {
  test("a syntactically-valid JSON-RPC 'initialize' call missing required params never assigns/echoes a session id", async () => {
    await reg("t2-malformed-init-client");
    const cleanup = await startApp();
    try {
      const res = await fetch(`${baseUrl}/mcp/t2-malformed-init-client`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        // Valid JSON-RPC envelope, real "initialize" method, but no `params`
        // — the SDK only assigns transport.sessionId once an initialize
        // request's params pass its own schema, so this must fail with no
        // mcp-session-id ever appearing on the response.
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("mcp-session-id")).toBeNull();
    } finally {
      await stopServer(cleanup);
      await cleanupClients();
    }
  });
});
