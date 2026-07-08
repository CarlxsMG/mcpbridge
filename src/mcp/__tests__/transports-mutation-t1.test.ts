/**
 * Stryker mutation-testing backstop for src/mcp/transports.ts — CLUSTER T1:
 * helpers + session-cleanup timer (source lines ~14-87): isValidSessionId's
 * regex anchoring, scopeKey's "system" literal, and the startSessionCleanup()
 * interval-callback body (TTL eviction loop).
 *
 * None of the functions under test are exported (only setupTransports/
 * getActiveSessionCount are), so everything here goes through real HTTP
 * requests against a real Express app wired via setupTransports, exactly
 * like the existing sibling files. App-boot / auth / handshake idioms are
 * copied verbatim from them rather than reinvented:
 *   - transports.test.ts            — startApp/stopServer shape, /mcp
 *                                      system-plane auth via
 *                                      config.adminApiKeys + Bearer header.
 *   - transports-session-id.test.ts — isValidSessionId 400 INVALID_SESSION_ID
 *                                      guard shape.
 *   - transports-sharded.test.ts    — real MCP JSON-RPC handshake helper
 *                                      (initSession), registry.register()
 *                                      via reg(), confused-deputy pattern.
 *
 * Each test/comment below cites the exact line:column, mutator, and
 * replacement it targets, per the house convention established in
 * registry-persistence-mutation.test.ts.
 *
 * ---------------------------------------------------------------------------
 * EQUIVALENT MUTANTS — documented per task instructions rather than silently
 * dropped, after exhausting real black-box options:
 * ---------------------------------------------------------------------------
 *
 *   - 45:25-45:33 and 45:36-45:44, both StringLiteral ("system" -> "") on
 *     scopeKey's `return scope.kind === "system" ? "system" : ...` line —
 *     two DISTINCT literals (the `===` comparison target at column 25, and
 *     the ternary's true-branch return value at column 36; an earlier
 *     revision of this note conflated the two under a single location).
 *     Both are equivalent for the same underlying reason: every reachable
 *     caller computes its OWN scopeKey() fresh — using the SAME (possibly
 *     mutated) function — both for the value stored into `sessionScope` at
 *     session-creation time and the value it's later compared against, so
 *     each literal only has to be internally self-consistent, never
 *     externally distinguishable through the HTTP surface.
 *       - Mutating column 36 (the return value) makes scopeKey({kind:
 *         "system"}) return "" directly.
 *       - Mutating column 25 (the comparison target) makes
 *         `scope.kind === ""` always false (scope.kind is never ""), so a
 *         system scope falls through to the `${kind}:${name}` branch
 *         instead — but McpServerScope's system variant carries no `name`
 *         field, so this evaluates to the literal string "system:undefined"
 *         instead of "system".
 *     Neither result ("" nor "system:undefined") can collide with a real
 *     client/bundle key ("client:<name>" / "bundle:<name>"): Express's
 *     `/mcp/:clientName` and `/mcp-custom/:bundleName` routes never match an
 *     empty path segment, so `name` can never be "" or the literal string
 *     "undefined" is still prefixed by "client:"/"bundle:", never "system:"
 *     or plain "". Verified empirically below: the confused-deputy test (a
 *     system-scoped session replayed against a real client's shard) 404s
 *     the same way regardless of which of these two literals is mutated.
 *
 *   - 70:13-70:23 ConditionalExpression ("true") on `if (streamable)` inside
 *     the TTL-eviction loop. Distinguishing this needs a `sessionActivity`
 *     entry whose `streamableSessions` entry is already gone (so the real
 *     `if` is false, but a true-forced mutant still enters the block and
 *     calls `.close()` on `undefined` — caught by the empty `catch {}`, but
 *     the extra `activeSessionCount--` that follows inside the block WOULD
 *     be externally observable as an extra decrement). No reachable code
 *     path produces that state: every place that deletes from
 *     `streamableSessions` (the transport's own `onclose`, this very loop,
 *     the explicit-DELETE handler, graceful shutdown) removes the matching
 *     `sessionActivity` entry in the very same synchronous turn, and
 *     `touchSession()` — the only writer of `sessionActivity` — always runs
 *     strictly *after* the corresponding `streamableSessions.set()` on the
 *     new-session path (see lines ~177-183). Concretely checked against
 *     node_modules/@modelcontextprotocol/sdk's
 *     dist/esm/server/webStandardStreamableHttp.js: `handleDeleteRequest`
 *     itself calls `await this.close()`, which invokes our `onclose` (and
 *     therefore deletes the `sessionActivity` entry too) *before*
 *     `handleStreamableDelete`'s own trailing map-cleanup lines ever run —
 *     so even an explicit DELETE can't produce an "activity without a
 *     transport" state. The sibling `false`-forced variant of this same
 *     mutant location IS reachable and IS killed below (a genuinely-live
 *     `streamable` is real, but the guard is forced permanently closed).
 *
 *   - 18:10-18:31 ConditionalExpression ("typeof s === \"string\"" -> "true")
 *     on isValidSessionId. Node's http parser only arrayifies a small
 *     hardcoded set of header names (set-cookie, etc.); "mcp-session-id" is
 *     not one of them, so any duplicate/multi-value send is comma-joined
 *     into a single string by Node itself before Express ever sees it —
 *     req.headers["mcp-session-id"] is therefore always `string | undefined`
 *     in practice, never an array or other type, for every real HTTP client.
 *     Since `rawSessionId === undefined` is already handled separately at
 *     transports.ts's own L106 ternary (isValidSessionId is only ever
 *     invoked with a genuine string), the `typeof s === "string"` guard
 *     inside isValidSessionId is TypeScript-level defensive narrowing for
 *     the exported `s: unknown` signature, not a runtime-reachable branch.
 *
 * ---------------------------------------------------------------------------
 * Timer technique for the interval-callback-body mutants (lines ~64-82):
 * ---------------------------------------------------------------------------
 * startSessionCleanup() schedules a real hardcoded 60_000ms setInterval, so
 * no test sleeps for real. `globalThis.setInterval` is swapped for a
 * capturing stub immediately before calling the local startApp() helper
 * (setupTransports() calls startSessionCleanup() synchronously at its very
 * top, which calls setInterval exactly once), then the captured callback is
 * invoked directly to force exactly one cleanup pass synchronously. The real
 * setInterval is restored in a `finally` — every later test's timers must
 * see the real one again.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

// ---------------------------------------------------------------------------
// App factory — mirrors the sibling files' shape.
// ---------------------------------------------------------------------------

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
  cleanupFn = null;
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

// ===========================================================================
// isValidSessionId (lines ~14-19)
// ===========================================================================

describe("T1 — isValidSessionId regex is fully anchored (14:20-14:92 Regex -> drop leading ^)", () => {
  afterEach(stopApp);

  test("a session id with garbage BEFORE a trailing valid-UUID suffix is still rejected as invalid", async () => {
    await startApp();
    // Without the leading ^, .test() finds the valid-UUID substring anchored
    // only at the end (the trailing $ survives this mutant) and wrongly
    // accepts it. With the real anchored regex this must stay a 400.
    const res = await fetch(`${baseUrl}/mcp/probe-client`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "xxx00000000-0000-4000-8000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });

  // Stryker's regex mutator generates more than one candidate for this
  // literal across runs — sometimes dropping the leading ^ (test above),
  // sometimes the trailing $ instead (seen dropping trailing $ while keeping
  // ^ in a later verify pass). Without the trailing $, .test() would find a
  // valid-UUID substring anchored only at the start and wrongly accept
  // extra garbage AFTER it — the mirror image of the test above.
  test("a session id with a valid-UUID prefix followed by garbage is still rejected as invalid", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/mcp/probe-client`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-0000-4000-8000-000000000000xxx",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

describe("T1 — isValidSessionId's format check is not forced-true (18:10-18:31 ConditionalExpression -> true)", () => {
  afterEach(stopApp);

  test("a clearly non-UUID session id is still rejected with 400 INVALID_SESSION_ID on the sharded endpoint", async () => {
    await startApp();
    // Re-verified specifically on /mcp/:clientName (a different scope/auth
    // chain than transports-session-id.test.ts's /mcp-only coverage) so this
    // exact branch shape is exercised, not just assumed covered elsewhere.
    const res = await fetch(`${baseUrl}/mcp/probe-client`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-uuid",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_SESSION_ID");
  });
});

// ===========================================================================
// scopeKey (lines ~44-46) — see EQUIVALENT MUTANTS note above for 45:25-45:33
// ===========================================================================

describe("T1 — scopeKey namespacing: a system-scoped session can't be replayed on a client's shard", () => {
  afterEach(async () => {
    await registry.unregister("t1-scopekey-client").catch(() => {});
    await stopApp();
  });

  test("a session established against the SYSTEM scope 404s when replayed (GET) against a real client's /mcp/:clientName", async () => {
    const ROOT_KEY = "t1-scopekey-root-key";
    await withConfig({ adminApiKeys: [ROOT_KEY] }, async () => {
      await startApp();
      await reg("t1-scopekey-client");

      const systemSessionId = await initSession("/mcp", { Authorization: `Bearer ${ROOT_KEY}` });
      expect(systemSessionId).not.toBeNull();

      const res = await fetch(`${baseUrl}/mcp/t1-scopekey-client`, {
        method: "GET",
        headers: { "mcp-session-id": systemSessionId!, accept: "text/event-stream" },
      });
      expect(res.status).toBe(404);
    });
  });
});

// ===========================================================================
// startSessionCleanup interval callback (lines ~64-82)
// ===========================================================================

describe("T1 — session-cleanup interval callback: a stale session IS evicted by a forced tick", () => {
  afterEach(async () => {
    await registry.unregister("t1-cleanup-client-stale").catch(() => {});
  });

  test("one forced cleanup tick with an expired TTL evicts the session, decrements the counter by exactly 1, and the session id 404s afterwards", async () => {
    await reg("t1-cleanup-client-stale");

    const origTtl = config.sessionTtlMs;
    (config as Record<string, unknown>).sessionTtlMs = -1; // guarantees `now - lastActivity > ttl` is true immediately

    const realSetInterval = globalThis.setInterval;
    let capturedTick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedTick = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval;

    try {
      await startApp();

      // 64:38-82:2 BlockStatement -> {} (whole startSessionCleanup body
      // emptied): setInterval would never be called and capturedTick would
      // stay undefined.
      expect(capturedTick).toBeDefined();

      const { getActiveSessionCount } = await import("../../mcp/transports.js");
      const before = getActiveSessionCount();

      const sessionId = await initSession("/mcp/t1-cleanup-client-stale");
      expect(sessionId).not.toBeNull();
      expect(getActiveSessionCount()).toBe(before + 1);

      capturedTick!();

      // 65:36-81:4 BlockStatement -> {} (setInterval callback body emptied),
      // 67:55-80:6 BlockStatement -> {} (for-loop body emptied),
      // 68:11-68:51 ConditionalExpression -> false (TTL check forced off),
      // 70:13-70:23 ConditionalExpression -> false (if(streamable) forced
      // closed even though the transport is genuinely live here):
      // every one of these would leave the session alive, i.e. count would
      // stay at before+1 instead of dropping back to before.
      //
      // 76:44-76:66 ArithmeticOperator (-1 -> +1): a flipped sign would make
      // this *increase* to before+2 instead of decrease to before — an exact
      // `toBe(before)` catches both the "didn't move" and the "moved the
      // wrong way" failure modes in one assertion.
      expect(getActiveSessionCount()).toBe(before);

      // NOTE: 71:15-73:12 (try{streamable.close()}catch{}) is NOT killed by
      // this follow-up alone — the map entries are already deleted at
      // L74-76 regardless of whether close() itself ran, so a GET against
      // the evicted session id 404s identically either way. See the
      // dedicated "close() really tears down a live SSE stream" test below
      // for the test that actually distinguishes this mutant.
      const followUp = await fetch(`${baseUrl}/mcp/t1-cleanup-client-stale`, {
        method: "GET",
        headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
      });
      expect(followUp.status).toBe(404);
    } finally {
      globalThis.setInterval = realSetInterval;
      (config as Record<string, unknown>).sessionTtlMs = origTtl;
      await stopApp();
    }
  });
});

describe("T1 — session-cleanup interval callback: TTL eviction really calls streamable.close(), not just deletes map entries (71:15-73:12 BlockStatement -> {})", () => {
  afterEach(async () => {
    await registry.unregister("t1-cleanup-client-live-stream").catch(() => {});
  });

  test("a forced stale tick actually ends a live GET SSE stream on the evicted session, not just untracks it", async () => {
    await reg("t1-cleanup-client-live-stream");

    const origTtl = config.sessionTtlMs;
    (config as Record<string, unknown>).sessionTtlMs = -1;

    const realSetInterval = globalThis.setInterval;
    let capturedTick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedTick = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval;

    try {
      await startApp();
      expect(capturedTick).toBeDefined();

      const sessionId = await initSession("/mcp/t1-cleanup-client-live-stream");
      expect(sessionId).not.toBeNull();

      const controller = new AbortController();
      const streamOutcome = (async (): Promise<"ended" | "aborted-or-errored"> => {
        try {
          const res = await fetch(`${baseUrl}/mcp/t1-cleanup-client-live-stream`, {
            method: "GET",
            headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (res.status !== 200 || !res.body) return "aborted-or-errored";
          const reader = res.body.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) return "ended";
          }
        } catch {
          return "aborted-or-errored";
        }
      })();

      // Give the GET a moment to actually register its stream server-side
      // before the tick runs — mirrors the equivalent technique in
      // transports-mutation-t5.test.ts for the graceful-shutdown cleanup.
      await new Promise((resolve) => setTimeout(resolve, 100));
      capturedTick!();

      const raceResult = await Promise.race([
        streamOutcome,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500)),
      ]);
      controller.abort();

      // If 71:15-73:12 were emptied, streamable.close() never runs — the map
      // entries are still deleted by the surrounding code (L74-76), so the
      // session becomes untracked, but the ALREADY-OPEN stream itself is
      // never told to end and just hangs until this test's own timeout race
      // fires, giving "timeout" instead of "ended".
      expect(raceResult).toBe("ended");
    } finally {
      globalThis.setInterval = realSetInterval;
      (config as Record<string, unknown>).sessionTtlMs = origTtl;
      await stopApp();
    }
  });
});

describe("T1 — session-cleanup interval callback: TTL boundary is strictly-greater-than, not greater-or-equal (68:11-68:51 EqualityOperator '>' -> '>=')", () => {
  afterEach(async () => {
    await registry.unregister("t1-cleanup-client-boundary").catch(() => {});
  });

  test("a tick where elapsed time exactly equals the TTL does NOT evict; one more ms past it does", async () => {
    await reg("t1-cleanup-client-boundary");

    const origTtl = config.sessionTtlMs;
    const TTL = 1000;
    (config as Record<string, unknown>).sessionTtlMs = TTL;

    const realSetInterval = globalThis.setInterval;
    let capturedTick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedTick = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval;

    const realDateNow = Date.now;
    let mockedNow = realDateNow();
    Date.now = () => mockedNow;

    try {
      await startApp();
      expect(capturedTick).toBeDefined();

      const { getActiveSessionCount } = await import("../../mcp/transports.js");
      const before = getActiveSessionCount();

      const t0 = mockedNow;
      const sessionId = await initSession("/mcp/t1-cleanup-client-boundary"); // touchSession() records lastActivity = t0
      expect(sessionId).not.toBeNull();
      expect(getActiveSessionCount()).toBe(before + 1);

      // now - lastActivity === TTL exactly: the real "> TTL" is false (not
      // evicted); a ">=" mutant would wrongly evict here.
      mockedNow = t0 + TTL;
      capturedTick!();
      expect(getActiveSessionCount()).toBe(before + 1);

      // now - lastActivity === TTL + 1: strictly past the boundary, evicted
      // under both the real code and the mutant — confirms the session
      // genuinely stayed alive above (not just uncounted) by verifying it's
      // still alive here, then that this second tick truly does evict it.
      mockedNow = t0 + TTL + 1;
      capturedTick!();
      expect(getActiveSessionCount()).toBe(before);
    } finally {
      Date.now = realDateNow;
      globalThis.setInterval = realSetInterval;
      (config as Record<string, unknown>).sessionTtlMs = origTtl;
      await stopApp();
    }
  });
});

describe("T1 — session-cleanup interval callback: a session within TTL survives a forced tick", () => {
  afterEach(async () => {
    await registry.unregister("t1-cleanup-client-healthy").catch(() => {});
  });

  test("one forced cleanup tick with a generous TTL does not evict a fresh session", async () => {
    await reg("t1-cleanup-client-healthy");

    const origTtl = config.sessionTtlMs;
    (config as Record<string, unknown>).sessionTtlMs = 24 * 60 * 60 * 1000; // 24h — nowhere near stale

    const realSetInterval = globalThis.setInterval;
    let capturedTick: (() => void) | undefined;
    globalThis.setInterval = ((fn: () => void, _ms: number) => {
      capturedTick = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setInterval;

    try {
      await startApp();
      expect(capturedTick).toBeDefined();

      const { getActiveSessionCount } = await import("../../mcp/transports.js");
      const before = getActiveSessionCount();

      const sessionId = await initSession("/mcp/t1-cleanup-client-healthy");
      expect(sessionId).not.toBeNull();
      expect(getActiveSessionCount()).toBe(before + 1);

      capturedTick!();

      // 68:11-68:51 ConditionalExpression -> true (TTL check forced
      // permanently on): would evict this healthy, non-stale session anyway.
      expect(getActiveSessionCount()).toBe(before + 1);

      // Confirm the session is still genuinely usable, not just uncounted —
      // DELETE (rather than a long-lived GET/SSE stream) so the assertion
      // resolves immediately and the session is cleanly torn down.
      const followUp = await fetch(`${baseUrl}/mcp/t1-cleanup-client-healthy`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId! },
      });
      expect(followUp.status).not.toBe(404);
    } finally {
      globalThis.setInterval = realSetInterval;
      (config as Record<string, unknown>).sessionTtlMs = origTtl;
      await stopApp();
    }
  });
});
