/**
 * Stryker mutation-testing backstop for src/mcp/transports.ts — CLUSTER T4:
 * handleStreamableGet and handleStreamableDelete (source lines ~212-265).
 *
 * These two handlers are structurally near-identical (UUID-format guard ->
 * scope-mismatch 404 -> "not found" 404 -> success), so the same real-HTTP
 * technique is used for both, just against GET vs DELETE. Every test drives
 * setupTransports(app) with real fetch() calls — nothing internal is
 * imported except getActiveSessionCount(), the only other export besides
 * setupTransports itself. The real MCP JSON-RPC initialize handshake
 * (initSession) mirrors transports-sharded.test.ts's helper so a session is
 * genuinely bound to a real scope via the real code path, not a fake.
 *
 * Each test/comment cites the exact line:column, mutator, and replacement it
 * targets, per the house convention (see registry-persistence-mutation.test.ts).
 * Current line numbers as of writing (re-check against the live file if they
 * drift): L216 GET's 400 message, L221/222 GET's scope-mismatch, L226-233
 * GET's "not found", L234/235 GET's success headers, L243 DELETE's 400
 * message, L248/249 DELETE's scope-mismatch, L253-260 DELETE's "not found",
 * L264 DELETE's activeSessionCount decrement.
 *
 * ---------------------------------------------------------------------------
 * EQUIVALENCE NOTES (documented per task instructions rather than dropped
 * silently — both were checked empirically, not assumed; see the two
 * "second DELETE" / real-successful-GET tests below for the supporting runs):
 *
 * 1. L226:19-233:4 (GET's "if (!transport)" not-found block) and L253:19-260:4
 *    (DELETE's identical-shaped block), plus every mutant strictly INSIDE
 *    those blocks (227:26-231:6, 228:16-228:21, 229:14-229:60, 229:22-229:28,
 *    229:39-229:58 for GET; 254:26-258:6, 255:16-255:21, 256:14-256:60,
 *    256:22-256:28, 256:39-256:58 for DELETE) are UNREACHABLE through the
 *    public HTTP surface, and therefore equivalent for black-box testing:
 *
 *      Every code path in this file that removes an id from `streamableSessions`
 *      (transport.onclose, the TTL cleanup loop's `if (streamable)` branch,
 *      handleStreamableDelete's own explicit cleanup, and setupTransports'
 *      returned graceful-shutdown closure) ALSO removes the same id from
 *      `sessionScope` in the same synchronous block, with no `await` between
 *      the two `.delete()` calls. Symmetrically, the only path that ADDS to
 *      `streamableSessions` (the new-session branch of handleStreamablePost)
 *      also adds to `sessionScope` in the same synchronous block. So for any
 *      serialized (non-racy) sequence of public HTTP calls,
 *      `streamableSessions.has(id) === sessionScope.has(id)` always holds:
 *      either both are present (scope check passes, transport lookup
 *      succeeds) or both are absent (scope check already fails first, since
 *      it runs BEFORE the transport lookup in both handlers) — "scope check
 *      passes but transport is missing" cannot be produced by any sequential
 *      script. This was verified empirically: a second DELETE of an
 *      already-deleted session (the most promising candidate for reaching
 *      this state) lands back on the scope-mismatch branch (L248/249), not
 *      the not-found branch, because the first DELETE already cleared
 *      `sessionScope` too — see the "second DELETE" test below, whose logged
 *      response body is byte-identical to the scope-mismatch body precisely
 *      because DELETE's two 404 branches share the same literal shape.
 *
 *    The one PARTIAL exception is the outer condition itself,
 *    226:7-226:17 / 253:7-253:17 (BooleanLiteral + 2x ConditionalExpression
 *    on `if (!transport)`): the "always TRUE" mutant IS killed as a side
 *    effect of this file's real-success tests below (forcing every request
 *    — including ones with a real, live transport — into the 404 branch
 *    breaks the success path, which those tests assert against). Only the
 *    "always FALSE" sub-variant (which changes nothing observable, since the
 *    branch is never legitimately entered anyway) remains equivalent.
 *
 * 2. L234:34-234:58 (StringLiteral on the VALUE `"no-cache, no-transform"` in
 *    `res.setHeader("Cache-Control", "no-cache, no-transform")`) is equivalent
 *    for black-box HTTP testing. The MCP SDK's own GET handler
 *    (@modelcontextprotocol/sdk's webStandardStreamableHttp.js) independently
 *    sets its OWN `Cache-Control: no-cache, no-transform` header on the
 *    Response object it returns from `handleGetRequest`. That Response's
 *    headers are later applied via `@hono/node-server`'s `getRequestListener`
 *    using `outgoing.writeHead(status, headerRecord)` — and per Node's
 *    documented writeHead semantics, a header present in both a prior
 *    `res.setHeader()` call AND the `writeHead()` call's header record is
 *    won by the `writeHead()` value. Since `transport.handleRequest(req, res)`
 *    always runs (and its Response always carries the SDK's own
 *    Cache-Control) after transports.ts's L234 sets it, the FINAL header
 *    value is always "no-cache, no-transform" regardless of what L234's
 *    value literal is mutated to — verified empirically with a standalone
 *    `http.createServer` reproduction of the exact setHeader-then-writeHead
 *    sequence. (L234's HEADER-NAME literal, 234:17-234:32, is different: an
 *    empty-string header name makes `res.setHeader()` throw synchronously
 *    under Bun's http implementation — verified empirically — which turns
 *    the success path into a non-200 response, so that half IS killed by the
 *    success-path test below.) L235 (X-Accel-Buffering, both name and value)
 *    has no SDK-side collision at all — the SDK never sets that header name
 *    — so both halves are cleanly, directly killed by asserting its exact
 *    value on a real successful GET.
 * ---------------------------------------------------------------------------
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";

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

/** Performs the real MCP initialize handshake against `path`. Returns the session id, or null if init failed. */
async function initSession(path: string): Promise<string | null> {
  const initRes = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
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
// L216:53-216:83 StringLiteral [Survived] — GET's own copy of the 400
// INVALID_SESSION_ID message text.
// ---------------------------------------------------------------------------

describe("GET /mcp/:clientName — 400 INVALID_SESSION_ID exact message text (L216)", () => {
  test("a malformed mcp-session-id returns the exact message string, not just a 400", async () => {
    await startApp();
    await reg("client-a");

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "GET",
      headers: { "mcp-session-id": "not-a-uuid", accept: "text/event-stream" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
    expect(body.error?.message).toBe("Session ID must be a UUID v4");
  });
});

// ---------------------------------------------------------------------------
// L243:53-243:83 StringLiteral [Survived] — DELETE's own copy of the same
// 400 message text.
// ---------------------------------------------------------------------------

describe("DELETE /mcp/:clientName — 400 INVALID_SESSION_ID exact message text (L243)", () => {
  test("a malformed mcp-session-id returns the exact message string, not just a 400", async () => {
    await startApp();
    await reg("client-a");

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": "../etc/passwd" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
    expect(body.error?.message).toBe("Session ID must be a UUID v4");
  });
});

// ---------------------------------------------------------------------------
// L221:7-221:54 ConditionalExpression [Survived] "true" — GET's scope-match
// check forced true would 404 EVERY GET, even one correctly bound to the
// right scope. L226:7-226:17's "always true" sub-variant is killed here too
// (see file header): forcing "if (!transport)" to always fire would ALSO
// wrongly 404 this legitimate request. L234/L235 (success headers) are
// asserted in the same test since they require the same working success
// path — see the file header for why L234's value-literal half is
// documented equivalent instead of asserted as "killed".
// ---------------------------------------------------------------------------

describe("GET /mcp/:clientName — a session correctly bound to this scope succeeds (L221, L226 true-variant, L234, L235)", () => {
  test("real handshake + real GET on the SAME scope returns 200 with the SSE success headers, not a wrongful 404", async () => {
    await startApp();
    await reg("client-a");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
    });
    try {
      expect(res.status).toBe(200);
      // L234 — header name kills via the earlier throw-on-invalid-name path
      // (see file header); asserting the value here is a correctness check,
      // not proof the value-literal mutant was killed (it's equivalent).
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      // L235 — no SDK-side collision, so both the name and the value here
      // are cleanly, directly load-bearing for killing 235:17/235:38.
      expect(res.headers.get("x-accel-buffering")).toBe("no");
    } finally {
      // The GET opens a standalone SSE stream that never closes on its own —
      // cancel it explicitly so afterEach's server.close() doesn't hang
      // waiting for this connection to end.
      await res.body?.cancel().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// L222:26-222:109, L222:37-222:42, L222:51-222:97, L222:59-222:65,
// L222:76-222:95 — GET's scope-mismatch 404 body (a distinct literal copy
// from POST's and DELETE's own copies). Real handshake against scope A, GET
// against scope B's URL with that session id; assert the exact body:
// jsonrpc "2.0", error code -32000, non-empty message, and id. Confirmed
// from the real source: GET (unlike POST) hardcodes `id: null` unconditionally
// — there is no req.body?.id involved since GET has no body.
// ---------------------------------------------------------------------------

describe("GET /mcp/:otherClient — confused-deputy scope-mismatch 404 body shape (L222)", () => {
  test("a session bound to client-a hitting client-b's GET URL gets the exact jsonrpc error body", async () => {
    await startApp();
    await reg("client-a");
    await reg("client-b");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/client-b`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });

    // The session must still be usable against its OWN scope afterwards —
    // proves the mismatch check didn't tear anything down.
    const stillWorks = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
    });
    expect(stillWorks.status).toBe(200);
    await stillWorks.body?.cancel().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// L248:7-248:54 ConditionalExpression [Survived] "true" — DELETE's
// scope-mismatch check forced true, same shape as L221 but for DELETE.
// DELETE is much easier to fully await since it doesn't open a stream. This
// same real-success test also kills L253:7-253:17's "always true"
// sub-variant (see file header) and is the base case L264's decrement tests
// (below) build on.
// ---------------------------------------------------------------------------

describe("DELETE /mcp/:clientName — a session correctly bound to this scope succeeds (L248, L253 true-variant)", () => {
  test("real handshake + real DELETE on the SAME scope returns 200, not a wrongful 404", async () => {
    await startApp();
    await reg("client-a");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// L249:26-249:109, L249:37-249:42, L249:51-249:97, L249:59-249:65,
// L249:76-249:95 — DELETE's scope-mismatch 404 body (own literal copy) —
// same body-assertion technique as GET's L222, plus proving the mismatched
// DELETE did NOT terminate the session (adapted from
// transports-sharded.test.ts's existing confused-deputy DELETE pattern).
// ---------------------------------------------------------------------------

describe("DELETE /mcp/:otherClient — confused-deputy scope-mismatch 404 body shape (L249)", () => {
  test("a session bound to client-a hitting client-b's DELETE URL gets the exact jsonrpc error body and is not terminated", async () => {
    await startApp();
    await reg("client-a");
    await reg("client-b");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/client-b`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });

    // Still alive against its own (correct) scope afterwards.
    const stillDeletable = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(stillDeletable.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// L253:7-253:17 (BooleanLiteral + 2x ConditionalExpression), L253:19-260:4,
// L254:26-258:6, L255:16-255:21, L256:14-256:60, L256:22-256:28,
// L256:39-256:58 — DELETE's "not found" 404 (transport undefined despite
// scope match). Per the file header's equivalence note, this narrower
// branch is unreachable through the public surface because a successful
// DELETE clears BOTH streamableSessions and sessionScope (via the SDK's own
// `this.close()` -> onclose cleanup AND transports.ts's own explicit
// L262-263 cleanup) before this handler returns. This test empirically
// confirms a second DELETE of the same session id lands back on the
// scope-mismatch branch (L248/249), not this one — sessionScope no longer
// has an entry, so `sessionScope.get(sessionId) !== scopeKey(scope)` is
// true (undefined !== a real scope key) before the transport-lookup line
// is ever reached.
// ---------------------------------------------------------------------------

describe("DELETE /mcp/:clientName — a second DELETE of the same session (documents L253-260 unreachability)", () => {
  test("after a successful DELETE, sessionScope is cleared too, so a repeat DELETE re-hits the scope-mismatch branch, not a distinct not-found branch", async () => {
    await startApp();
    await reg("client-a");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const first = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(second.status).toBe(404);
    // Byte-identical to the scope-mismatch body (L249) — DELETE's two 404
    // branches share the exact same response shape, which is precisely why
    // L253-260 cannot be distinguished from L248-249 through the HTTP
    // surface even if it WERE reachable.
    const body = await second.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// L264:24-264:59 MethodExpression and L264:36-264:58 ArithmeticOperator —
// Math.max(0, activeSessionCount - 1) at the end of a successful DELETE.
//
// IMPORTANT — empirically observed, NOT the naive "decreases by exactly 1"
// assumption: a successful DELETE actually decrements activeSessionCount
// TWICE. handleStreamableDelete awaits `transport.handleRequest(req, res)`,
// and the SDK's own DELETE handler (webStandardStreamableHttp.js's
// handleDeleteRequest) calls `await this.close()` internally, which fires
// the `transport.onclose` callback transports.ts registered at session
// creation (L160-168) — that callback ALREADY does the full
// streamableSessions/sessionActivity/sessionScope/activeSessionCount
// cleanup once. THEN, after handleRequest resolves, handleStreamableDelete's
// own L261-264 run a SECOND time, decrementing activeSessionCount again
// (the map deletes at L262-263 are harmless no-ops at that point, but the
// counter arithmetic at L264 is not idempotent). With only one active
// session this double-decrement is invisible — the Math.max(0, ...) floor
// clamps both hits to the same final 0 — so a naive single-session test
// would pass even against a mutant that broke the arithmetic. Using
// multiple concurrent sessions avoids that clamp-masking and pins down the
// real delta.
// ---------------------------------------------------------------------------

describe("DELETE /mcp/:clientName — activeSessionCount decrement (L264)", () => {
  test("deleting one of three active sessions drops the count by exactly 2 (double-cleanup, not floor-masked)", async () => {
    await startApp();
    await reg("client-a");
    const { getActiveSessionCount } = await import("../../mcp/transports.js");

    const s1 = await initSession("/mcp/client-a");
    const s2 = await initSession("/mcp/client-a");
    const s3 = await initSession("/mcp/client-a");
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();

    const before = getActiveSessionCount();
    expect(before).toBeGreaterThanOrEqual(3);

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": s1! },
    });
    expect(res.status).toBe(200);

    const after = getActiveSessionCount();
    // If L264's arithmetic operator were flipped ("-" -> "+"), `after`
    // would be >= `before` instead of two less than it. If the Math.max
    // wrapper (MethodExpression) were stripped or altered, this specific
    // case wouldn't reveal it (only the floor test below does), but the
    // exact-delta assertion here still pins the real arithmetic outcome.
    expect(before - after).toBe(2);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  test("a single-session DELETE floors the count at 0, never negative (Math.max floor)", async () => {
    await startApp();
    await reg("client-a");
    const { getActiveSessionCount } = await import("../../mcp/transports.js");

    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();
    expect(getActiveSessionCount()).toBe(1);

    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(200);
    // The double-decrement (see the test above) would drive this to -1
    // without the Math.max(0, ...) floor — stripping the floor
    // (MethodExpression) surfaces here as a negative count instead of 0.
    expect(getActiveSessionCount()).toBe(0);
  });
});
