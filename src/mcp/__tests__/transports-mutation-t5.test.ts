/**
 * Stryker mutation-testing backstop for src/mcp/transports.ts — CLUSTER T5:
 * setupTransports(): the setSessionCountGetter wiring, all three route
 * groups' string-literal path segments (client-shard /mcp/:clientName,
 * bundle /mcp-custom/:bundleName, system-root /mcp), and the returned
 * graceful-shutdown cleanup function (source lines approx 267-358).
 *
 * Companion file to transports.test.ts / transports-session-id.test.ts /
 * transports-sharded.test.ts / transports-bundle.test.ts — reuses their
 * exact idioms (app-boot helper, real MCP JSON-RPC handshake over
 * Streamable HTTP, config.adminApiKeys + Bearer auth for /mcp) rather than
 * reinventing them; see those files for the underlying protocol details.
 * This file adds exactly one new file so parallel mutation-testing agents
 * working other clusters never conflict — it does not modify any existing
 * test file, and does not modify transports.ts itself.
 *
 * Citation convention (line:col MutatorName -> replacement) follows the
 * house style established in registry-persistence-mutation.test.ts.
 *
 * Mutants targeted here:
 *   269:25-271:5   ArrowFunction  -> setSessionCountGetter callback returns undefined
 *   269:32-271:4   ObjectLiteral  -> callback returns {} instead of {streamable: N}
 *   280:11-280:29  StringLiteral  -> "/mcp/:clientName" (originValidator) -> ""
 *   281:11-281:29  StringLiteral  -> "/mcp/:clientName" (mcpAuth) -> ""
 *   282:11-282:29  StringLiteral  -> "/mcp/:clientName" (rateLimitMcp) -> ""
 *   288:41-288:88 / 288:49-288:57 -> GET /mcp/:clientName's {kind:"client",...} scope object / "client" literal
 *   291:44-291:91 / 291:52-291:60 -> DELETE /mcp/:clientName's {kind:"client",...} scope object / "client" literal
 *   307:11-307:36  StringLiteral  -> "/mcp-custom/:bundleName" (originValidator) -> ""
 *   308:11-308:36  StringLiteral  -> "/mcp-custom/:bundleName" (mcpAuth) -> ""
 *   309:11-309:36  StringLiteral  -> "/mcp-custom/:bundleName" (rateLimitMcp) -> ""
 *   314:11-314:36  StringLiteral  -> GET "/mcp-custom/:bundleName" ROUTE path -> ""
 *   315:41-315:88 / 315:49-315:57 -> GET /mcp-custom/:bundleName's {kind:"bundle",...} scope object / "bundle" literal
 *   317:14-317:39  StringLiteral  -> DELETE "/mcp-custom/:bundleName" ROUTE path -> ""
 *   318:44-318:91 / 318:52-318:60 -> DELETE /mcp-custom/:bundleName's {kind:"bundle",...} scope object / "bundle" literal
 *   332:11-332:17  StringLiteral  -> "/mcp" (originValidator) -> ""
 *   333:11-333:17  StringLiteral  -> "/mcp" (rootMcpAuth) -> ""
 *   334:11-334:17  StringLiteral  -> "/mcp" (rateLimitMcp) -> ""
 *   340:41-340:59 / 340:49-340:57 -> GET /mcp's {kind:"system"} scope object / "system" literal
 *   343:44-343:62 / 343:52-343:60 -> DELETE /mcp's {kind:"system"} scope object / "system" literal
 *   347:16-357:4   BlockStatement -> returned cleanup function body emptied
 *   349:55-356:6   BlockStatement -> for-loop over streamableSessions emptied
 *   350:11-352:8   BlockStatement -> per-session `try { transport.close() } catch {}` emptied
 *   355:40-355:62  ArithmeticOperator/MethodExpression on Math.max(0, activeSessionCount - 1)
 *
 * Not independently targeted:
 *   284:52-286:4 / 311:59-313:4 / 336:40-338:4 BlockStatement [Timeout] — the
 *     POST route handler bodies for each group; an emptied handler sends no
 *     response at all, so every real POST test in this file (and its
 *     siblings) already kills these as a side effect.
 *
 * Documented as likely-equivalent (exhausted realistic HTTP-observable
 * options; reasoning inline where the gap is):
 *   348:9-348:21 (x2) ConditionalExpression on `if (cleanupTimer)`. By the
 *     time setupTransports()'s returned cleanup function can ever be
 *     invoked, startSessionCleanup() has already run synchronously and
 *     unconditionally assigned `cleanupTimer = setInterval(...)` — so at
 *     the call site `cleanupTimer` is always truthy. Forcing the condition
 *     to always-true is therefore behaviorally identical to the original.
 *     Forcing it to always-false skips `clearInterval`, which *does* leak
 *     the interval handle, but by the time it fires again 60s later every
 *     map the sweep touches (sessionActivity, streamableSessions,
 *     sessionScope) has already been emptied by the cleanup function itself
 *     (see the for-loop test below), so the leaked tick is a no-op sweep
 *     over empty maps — nothing externally observable changes within any
 *     practical test timeout short of actually waiting out a real 60s
 *     interval tick, which would make this file's runtime pathological for
 *     one mutant. Left undistinguished.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { initBundles, createBundle } from "../../admin/tool-composition/bundles.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import { getLegacyMetricsSnapshot } from "../../observability/metrics.js";

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

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  initBundles();
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopApp();
});

// ---------------------------------------------------------------------------
// 269:25-271:5 ArrowFunction / 269:32-271:4 ObjectLiteral — the callback
// passed to setSessionCountGetter. Verified through the ONLY public consumer
// of that stored getter, getLegacyMetricsSnapshot() (observability/metrics.ts),
// which calls it and exposes the result as `.sessions`. Delta-based (baseline
// captured right after boot, before opening any session) so this is immune
// to whatever leftover session count other test files in the same worker
// may have left behind.
// ---------------------------------------------------------------------------

describe("setSessionCountGetter wiring", () => {
  test("reports the live streamable-session count via getLegacyMetricsSnapshot (not undefined, not {})", async () => {
    await startApp();
    await reg("client-a");

    const baseline = (getLegacyMetricsSnapshot().sessions as { streamable?: number } | undefined)?.streamable;
    expect(typeof baseline).toBe("number");

    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const afterOpen = (getLegacyMetricsSnapshot().sessions as { streamable?: number } | undefined)?.streamable;
    expect(afterOpen).toBe((baseline as number) + 1);
  });
});

// ---------------------------------------------------------------------------
// 280/307/332 (originValidator), 281/308 (mcpAuth), 333 (rootMcpAuth),
// 282/309/334 (rateLimitMcp) StringLiteral mutants on each `app.use(path, ...)`
// call. An emptied path string mounts that middleware at "/" too, so it
// would fire on requests this app defines no route for at all. Each test
// below hits a bare "/" (never matched by any real route in this minimal
// test app) and confirms the corresponding middleware's rejection status
// does NOT appear there — i.e. the request falls through to Express's own
// unmatched-route 404, not a 403/401/429 from a misplaced middleware. A
// single test per middleware kind is sufficient to catch a mutation on ANY
// of that middleware's mount points (client-shard, bundle, or system-root),
// since whichever one gets un-scoped will be the one that intercepts "/".
// ---------------------------------------------------------------------------

describe("route-group middlewares are mounted only under their real path prefixes, never at '/'", () => {
  test("originValidator (kills 280/307/332): a disallowed Origin on '/' is not rejected — falls through to unmatched-route 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/`, {
      method: "GET",
      headers: { Origin: "http://mutant-only-origin.invalid" },
    });
    expect(res.status).toBe(404);
  });

  test("mcpAuth (kills 281/308): an unauthenticated '/' is not rejected even when MCP auth is configured — falls through to unmatched-route 404", async () => {
    await withConfig({ mcpApiKeys: ["dummy-required-key"] }, async () => {
      await startApp();
      const res = await fetch(`${baseUrl}/`, { method: "GET" });
      expect(res.status).toBe(404);
    });
  });

  test("rootMcpAuth (kills 333): an unauthenticated '/' is not rejected by the fail-closed system-root auth — falls through to unmatched-route 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("rateLimitMcp (kills 282/309/334): '/' is not rate-limited even with maxPerMinute=0 — falls through to unmatched-route 404", async () => {
    const origRateLimitMcp = config.rateLimitMcp;
    (config as Record<string, unknown>).rateLimitMcp = 0;
    try {
      await startApp();
      const res = await fetch(`${baseUrl}/`, { method: "GET" });
      expect(res.status).toBe(404);
    } finally {
      (config as Record<string, unknown>).rateLimitMcp = origRateLimitMcp;
    }
  });
});

// ---------------------------------------------------------------------------
// 314 / 317 StringLiteral — the GET/DELETE ROUTE registration paths
// themselves (app.get("/mcp-custom/:bundleName", ...) / app.delete(...)),
// distinct from the app.use(...) middleware mounts above. If emptied, the
// route would register at "/" instead, so a bare "/" request would be
// handled by handleStreamableGet/Delete with a {kind:"bundle", name:
// undefined} scope — producing a JSON 400/404 response (application/json)
// instead of Express's default unmatched-route 404 (text/html). Both are
// status 404 in the DELETE case, so content-type is the distinguishing
// signal; GET differs on status outright (400 INVALID_SESSION_ID, no
// session header sent) but we check content-type uniformly for both to keep
// the two tests symmetric.
// ---------------------------------------------------------------------------

describe("/mcp-custom/:bundleName GET/DELETE route registration — real path, not '/'", () => {
  test("GET / is not handled by the bundle GET route (kills 314)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  test("DELETE / is not handled by the bundle DELETE route (kills 317)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// 288/291 — GET/DELETE /mcp/:clientName's {kind: "client", name: ...} scope
// object (and the "client" literal within it). A real handshake opens a
// session recorded under scopeKey({kind:"client", name:"client-a"}) =
// "client:client-a" (built by the POST handler, out of this cluster's
// scope). If GET/DELETE's OWN scope-construction is mutated, the recorded
// scope won't match what GET/DELETE recompute, so the confused-deputy check
// (`sessionScope.get(sessionId) !== scopeKey(scope)`) wrongly trips and the
// call 404s instead of succeeding.
// ---------------------------------------------------------------------------

describe("GET/DELETE /mcp/:clientName really construct a client-kind scope", () => {
  test("GET succeeds against the client it was opened on, not the wrong-scope 404 (kills 288)", async () => {
    await startApp();
    await reg("client-a");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    // AbortController: GET opens a real standalone SSE stream that never
    // ends on its own — abort right after the status/headers are observed
    // so the connection doesn't dangle past this test (which would hang
    // afterEach's server.close()).
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });

  test("DELETE succeeds against the client it was opened on, not the wrong-scope 404 (kills 291)", async () => {
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
// 315/318 — same shape as 288/291 but for GET/DELETE /mcp-custom/:bundleName's
// {kind: "bundle", name: ...} scope object.
// ---------------------------------------------------------------------------

describe("GET/DELETE /mcp-custom/:bundleName really construct a bundle-kind scope", () => {
  test("GET succeeds against the bundle it was opened on, not the wrong-scope 404 (kills 315)", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await createBundle("mix", undefined, [{ client: "client-a", tool: "tool-a" }], "test");

    const sessionId = await initSession("/mcp-custom/mix");
    expect(sessionId).not.toBeNull();

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/mcp-custom/mix`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    controller.abort();
  });

  test("DELETE succeeds against the bundle it was opened on, not the wrong-scope 404 (kills 318)", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await createBundle("mix", undefined, [{ client: "client-a", tool: "tool-a" }], "test");

    const sessionId = await initSession("/mcp-custom/mix");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp-custom/mix`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 340/343 — same shape again but for GET/DELETE /mcp's {kind: "system"}
// scope object (note: no "name" field on the system scope, unlike
// client/bundle — see McpServerScope). /mcp uses rootMcpAuth (fail-closed),
// so every request needs the env admin Bearer.
// ---------------------------------------------------------------------------

describe("GET/DELETE /mcp really construct a system-kind scope", () => {
  const ROOT_KEY = "test-root-admin-key";
  const AUTH_HEADER = { Authorization: `Bearer ${ROOT_KEY}` };

  test("GET succeeds on the system session, not the wrong-scope 404 (kills 340)", async () => {
    await withConfig({ adminApiKeys: [ROOT_KEY] }, async () => {
      await startApp();
      const sessionId = await initSession("/mcp", AUTH_HEADER);
      expect(sessionId).not.toBeNull();

      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { "mcp-session-id": sessionId!, accept: "text/event-stream", ...AUTH_HEADER },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      controller.abort();
    });
  });

  test("DELETE succeeds on the system session, not the wrong-scope 404 (kills 343)", async () => {
    await withConfig({ adminApiKeys: [ROOT_KEY] }, async () => {
      await startApp();
      const sessionId = await initSession("/mcp", AUTH_HEADER);
      expect(sessionId).not.toBeNull();

      const res = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId!, ...AUTH_HEADER },
      });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// 347/349/350/355 — the graceful-shutdown function setupTransports() returns.
// Tested DIRECTLY against the returned function (not via stopApp()'s normal
// afterEach path), using real sessions from real handshakes.
// ---------------------------------------------------------------------------

describe("graceful-shutdown cleanup function returned by setupTransports", () => {
  test("calling cleanup() with zero active sessions does not throw and leaves the counter unchanged (347)", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    await startApp();
    const before = getActiveSessionCount();

    expect(() => cleanupFn!()).not.toThrow();
    cleanupFn = null; // already invoked directly; don't let afterEach's stopApp() call it again

    expect(getActiveSessionCount()).toBe(before);
  });

  test("cleanup() decrements the counter back to baseline for every real active session (347/349/355)", async () => {
    const { getActiveSessionCount } = await import("../../mcp/transports.js");
    await startApp();
    await reg("client-a");
    await reg("client-b");

    const before = getActiveSessionCount();
    const sessionA = await initSession("/mcp/client-a");
    const sessionB = await initSession("/mcp/client-b");
    expect(sessionA).not.toBeNull();
    expect(sessionB).not.toBeNull();
    expect(getActiveSessionCount()).toBe(before + 2);

    cleanupFn!();
    cleanupFn = null;

    expect(getActiveSessionCount()).toBe(before);

    // The sessions are really gone from the routing map, not just uncounted —
    // continuing either one now hits the same "stale session" 404 path any
    // other cleaned-up session would.
    const res = await fetch(`${baseUrl}/mcp/client-a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionA!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 9 }),
    });
    expect(res.status).toBe(404);
  });

  // 350:11-352:8 — the per-session `try { transport.close() } catch {}`.
  // Deleting the routing-map entries (already covered above) doesn't by
  // itself terminate an in-flight GET SSE stream — only transport.close()
  // does that (it tears down the transport's open stream controllers). So:
  // open a real GET stream and DON'T abort it client-side, call cleanup(),
  // and confirm the stream is actually ended server-side (the client's read
  // loop completes) rather than hanging forever. Bounded by a race against a
  // short timeout so this can never hang the suite even if wrong; the
  // fetch is explicitly aborted afterward either way so a lost race never
  // leaves a dangling connection for afterEach's server.close() to wait on.
  test("cleanup() actually closes each session's transport, ending a live GET SSE stream (kills 350)", async () => {
    await startApp();
    await reg("client-a");
    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const controller = new AbortController();
    const streamOutcome = (async (): Promise<"ended" | "aborted-or-errored"> => {
      try {
        const res = await fetch(`${baseUrl}/mcp/client-a`, {
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

    // Give the GET a moment to actually register its stream server-side.
    await new Promise((resolve) => setTimeout(resolve, 100));
    cleanupFn!();
    cleanupFn = null;

    const raceResult = await Promise.race([
      streamOutcome,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500)),
    ]);
    controller.abort();

    expect(raceResult).toBe("ended");
  });
});
