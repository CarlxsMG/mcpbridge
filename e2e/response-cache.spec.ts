/**
 * End-to-end test for the two per-tool "don't call the upstream" policies: the
 * response CACHE (`src/tool-policies/response-cache.ts`) and request COALESCING
 * (`src/tool-policies/coalesce.ts`).
 *
 * Neither feature is observable from the MCP side. A cache hit returns the same
 * bytes as the cold call that filled it, and a coalesced call returns the same
 * bytes as an uncoalesced one — so the only instrument that can tell them apart
 * is the fixture's per-path request counter (`support/fixture-server.ts`, read
 * through `fixtureState`). Every assertion below is therefore an exact upstream
 * hit DELTA, the same way circuit-breaker.spec.ts proves that an open breaker
 * stops dialling out. "The second call came back faster" would prove nothing.
 *
 * What that buys, per feature:
 *
 *   - CACHE: two identical calls, one upstream request — plus the control that
 *     stops every other assertion passing vacuously: an unconfigured tool hits
 *     the upstream on every single call, so the deltas really are the cache and
 *     not some ambient dedup in the transport or the fixture.
 *   - COALESCING: N genuinely CONCURRENT identical calls, one upstream request,
 *     and every one of the N callers answered with the real payload. The hit
 *     count alone cannot distinguish "collapsed correctly" from "collapsed and
 *     answered only the first caller", which is why each result is asserted too.
 *
 * Mechanics worth knowing while reading:
 *
 *   - Both policies are REST-GET-only and are consulted inside `proxyToolCall`
 *     (src/proxy/proxy.ts) AFTER every auth/scope/quota/guardrail gate and
 *     BEFORE the circuit breaker: a hit must never bypass authorization, and
 *     must never burn the breaker's single half-open probe slot.
 *   - The cache key is `client \0 tool \0 base_url \0 stableStringify(args)`
 *     (`cacheKey`). No caller identity in it, deliberately — a REST response
 *     here cannot vary by caller (upstream credentials are per-client, redaction
 *     is per-tool) and the stored text is the already-redacted one. Coalescing
 *     reuses the same key shape, so both share the keying tests' conclusions.
 *   - `ttlSeconds` really is SECONDS, and `validateCacheInput`'s floor is 1, so
 *     the expiry test waits out a REAL TTL in a couple of seconds rather than
 *     being skipped for being unreachable inside the 30s per-test timeout.
 *   - Writing the config PURGES that tool's entries (`setToolCacheConfig` ->
 *     `purgeToolCache`). That's why each cache test re-PATCHes its own policy:
 *     it doubles as "start from an empty store", including on a local re-run
 *     against a reused server (`reuseExistingServer`).
 *   - The cache config is WRITE-ONLY over the admin API — PATCH sets it, but
 *     `GET /admin-api/clients/:name` carries no `cache` field to read it back
 *     (`coalesce` IS there, per tool). The purge endpoint and the upstream hit
 *     counter are the only ways to observe the cache, which is what these tests
 *     use.
 *
 * `.serial`: the in-memory store is process-global and these tests walk it in
 * order (fill it, key it, expire it, purge it). Under parallel execution a
 * later test would be measuring a delta against someone else's entry.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import {
  apiHeaders,
  deleteClient,
  fixtureState,
  loginAs,
  mintMcpKey,
  registerViaApi,
  type AdminAuth,
} from "./support/admin";
import { initMcpSession, mcpToolsCall, type McpCallResult } from "./support/mcp";

// ── Fixtures under test ──────────────────────────────────────────────────────

/**
 * One client for the whole spec. Both policies live in `tool_cache` /
 * `tool_coalesce`, keyed `(client_name, tool_name)`, so three different TOOLS on
 * one client already give the three scenarios independent state — and using one
 * client is what lets the control test below prove the per-tool keying.
 */
const SERVER = "e2e-cache-api";
const DATA_PLANE = `/mcp/${SERVER}`;

/** The tool the cache tests opt in. */
const CACHED_TOOL = "list-users";
/** Deliberately never given a cache policy — the "caching is opt-in" control. */
const UNCACHED_TOOL = "echo";
/** The coalescing tool: only a genuinely slow upstream gives concurrent calls something to overlap in. */
const SLOW_TOOL = "slow";

/** Fixture paths as they appear in the hit counter — it records the path with the query string already split off. */
const USERS_PATH = "/api/v1/users";
const ECHO_PATH = "/api/v1/echo";
const SLOW_PATH = "/api/v1/slow";

/** TTL for the tests that must NOT see an expiry mid-test. Far longer than the whole spec. */
const LONG_TTL_SECONDS = 300;
/**
 * TTL for the expiry test. `validateCacheInput`'s floor is 1 second, which is
 * what makes this scenario testable at all — but 1 would leave the "still inside
 * the TTL" call racing the two control-channel round trips that precede it on a
 * loaded machine. 2 buys headroom in the only direction that can flake; the
 * expiry direction is safe at any value, since sleeping only ever overshoots.
 */
const SHORT_TTL_SECONDS = 2;
/** Slack over SHORT_TTL_SECONDS. `cacheGet` expires on `expiresAt <= now`, so this is comfortably past it. */
const TTL_EXPIRY_WAIT_MS = 2_500;

/** Calls the control test makes against the unconfigured tool; the expected delta is exactly this. */
const UNCACHED_CALLS = 3;

/**
 * How long the fixture's `slow` tool sleeps during the coalescing tests. Same
 * value guard-enforcement.spec.ts uses, and for the same reason: long enough
 * that concurrent callers genuinely overlap (they arrive microseconds apart, so
 * this is a ~1.2s-wide window to join an in-flight request), short enough that
 * even the retry path stays far below the 30s test timeout.
 */
const SLOW_MS = 1_200;
/** Concurrent callers in the coalescing test. Any N > 1 proves it; 4 makes an "only the leader was answered" bug loud. */
const COALESCED_CALLERS = 4;
/** Distinct `ms` arguments for the "different args are not collapsed" test — one caller each, one upstream hit each. */
const DISTINCT_SLEEP_MS = [1_000, 1_100, 1_200] as const;

/** The subset of `GET /admin-api/clients/:name` this spec reads back. `cache` has no counterpart here — see the header. */
interface ClientDetailView {
  tools: { name: string; coalesce?: { enabled: boolean } }[];
}

let page: Page;
let request: APIRequestContext;
let auth: AdminAuth;
/** Managed MCP key — the data plane is fail-closed once any key exists, so every call carries it. */
let authHeader: string;

// ── Local helpers (this spec owns them — e2e/support/* belongs to other specs) ─

/** PATCH one tool's policy. Every test SETS what it depends on rather than inheriting it from the test above. */
async function patchTool(toolName: string, body: Record<string, unknown>): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${toolName}`, {
    headers: apiHeaders(auth),
    data: body,
  });
  expect(res.status(), `PATCH ${toolName} ${JSON.stringify(body)} failed: ${await res.text()}`).toBe(200);
}

/** How many times the fixture has been asked for `path`, ever. Only deltas measured around an action are meaningful. */
async function hitsFor(path: string): Promise<number> {
  const { hits } = await fixtureState(request);
  return hits[path] ?? 0;
}

/** The tool's persisted coalescing config as an operator sees it, or undefined when no row exists. */
async function coalesceConfigOf(toolName: string): Promise<{ enabled: boolean } | undefined> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${SERVER}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client detail failed: ${await res.text()}`).toBe(200);
  const detail = (await res.json()) as ClientDetailView;
  return detail.tools.find((t) => t.name === toolName)?.coalesce;
}

async function openSession(): Promise<string> {
  const { sessionId } = await initMcpSession(DATA_PLANE, { authHeader, clientName: "e2e-cache" });
  return sessionId;
}

/**
 * Hand the session slot back. The gateway caps concurrent sessions
 * (`config.maxSessions`, 100) and only expires idle ones after SESSION_TTL_MS,
 * so a spec that opens one session per caller must close them or it taxes
 * whichever spec runs last.
 */
async function closeSession(sessionId: string): Promise<void> {
  await fetch(`${APP_BASE_URL}${DATA_PLANE}`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, authorization: authHeader },
  });
}

/** Run `fn` against one freshly opened session, closing it whatever happens. */
async function withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
  const sessionId = await openSession();
  try {
    return await fn(sessionId);
  } finally {
    await closeSession(sessionId);
  }
}

/** tools/call for one of this client's tools, addressed as `client__tool`. */
async function callTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpCallResult> {
  return mcpToolsCall(DATA_PLANE, sessionId, `${SERVER}__${toolName}`, authHeader, args);
}

/**
 * Fire one concurrent `tools/call` per entry of `argSets`, each from its OWN
 * session, and return the results in the same order.
 *
 * Two things this arranges on purpose. The sessions are established BEFORE any
 * tool call is fired: `initialize` is its own round trip, so opening them inside
 * the `Promise.all` would stagger the calls and eat into the window they have to
 * overlap in. And one session per caller means the callers are as independent as
 * real MCP clients would be — which is also what proves the coalescing key does
 * not include the caller's session.
 */
async function callConcurrently(
  toolName: string,
  argSets: readonly Record<string, unknown>[],
): Promise<McpCallResult[]> {
  const sessionIds = await Promise.all(argSets.map(() => openSession()));
  try {
    return await Promise.all(argSets.map((args, i) => callTool(sessionIds[i], toolName, args)));
  } finally {
    await Promise.all(sessionIds.map((id) => closeSession(id)));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test.describe.serial("per-tool response cache and request coalescing", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Delete-then-register rather than tolerating the 409 from a reused server.
    // `forgetClient` drops the `clients` row, and `tool_cache` / `tool_coalesce`
    // FK-cascade through `tools` — so this is what guarantees a local re-run
    // starts with no policy rows AND (via `purgeClientCache`) an empty store.
    await deleteClient(request, auth, SERVER);
    await registerViaApi(request, auth, SERVER, FIXTURE_OPENAPI_EXTENDED_PATH);

    authHeader = (await mintMcpKey(request, auth, "e2e-cache")).authHeader;
  });

  test.afterAll(async () => {
    try {
      // Drop the client, which takes both policies and every cached entry with
      // it: a re-run against a reused server must not meet this spec's cache.
      await deleteClient(request, auth, SERVER);
    } finally {
      await page.close();
    }
  });

  test("a second identical call is served from cache and never reaches the upstream", async () => {
    await patchTool(CACHED_TOOL, { cache: { enabled: true, ttlSeconds: LONG_TTL_SECONDS } });

    await withSession(async (session) => {
      const before = await hitsFor(USERS_PATH);

      const first = await callTool(session, CACHED_TOOL);
      expect(first.status).toBe(200);
      expect(first.isError, `cold call failed: ${first.text}`).toBeFalsy();
      expect(await hitsFor(USERS_PATH), "the first (cold) call must reach the upstream").toBe(before + 1);

      const second = await callTool(session, CACHED_TOOL);
      expect(second.status).toBe(200);
      expect(second.isError, `cached call failed: ${second.text}`).toBeFalsy();
      // The whole point of the spec: two calls, ONE upstream request.
      expect(await hitsFor(USERS_PATH), "the second call must be served from cache").toBe(before + 1);

      // The cached body is CORRECT, not merely present. Byte-identical to the
      // cold response, and carrying the fixture's real payload — a cache that
      // stored an empty or placeholder body would satisfy equality alone, and a
      // constant upstream body means equality alone can't prove a hit either.
      expect(second.text).toBe(first.text);
      expect(first.text).toContain("Ada Lovelace");
      expect(first.text).toContain("Grace Hopper");
    });
  });

  test("the cache is keyed on the call arguments, canonicalised", async () => {
    // Re-PATCHing purges, so this test starts from an empty store for this tool.
    await patchTool(CACHED_TOOL, { cache: { enabled: true, ttlSeconds: LONG_TTL_SECONDS } });

    await withSession(async (session) => {
      const before = await hitsFor(USERS_PATH);

      await callTool(session, CACHED_TOOL, {});
      await callTool(session, CACHED_TOOL, {});
      expect(await hitsFor(USERS_PATH), "identical args: one upstream request for two calls").toBe(before + 1);

      // Different args must not read another entry's value. The fixture ignores
      // `?limit`, so the RESPONSE is identical to the one already cached — which
      // is exactly why the hit delta, not the body, is what catches a key
      // collision here.
      const differing = await callTool(session, CACHED_TOOL, { limit: 1 });
      expect(differing.isError, `differing-args call failed: ${differing.text}`).toBeFalsy();
      expect(differing.text).toContain("Ada Lovelace");
      expect(await hitsFor(USERS_PATH), "different args must not share a cache entry").toBe(before + 2);

      // ...and the new args got their OWN entry rather than simply bypassing the
      // cache: repeating them is a hit.
      await callTool(session, CACHED_TOOL, { limit: 1 });
      expect(await hitsFor(USERS_PATH), "the second argument set must be cached in its own right").toBe(before + 2);

      // The key is built from the args as the CALLER sent them: proxy.ts computes
      // `cacheKey` before dispatch, while Ajv (`removeAdditional: "all"`) strips
      // unknown keys inside dispatch-rest.ts. So `unusedProbe` never reaches the
      // upstream — this request is byte-identical on the wire to the one above —
      // and it still misses. Harmless (an extra miss, never a wrong hit), but
      // pinned: if this ever stops missing, key computation moved behind
      // validation, and the reverse (a key built post-strip) would be a
      // deliberate change, not an accident.
      const probed = await callTool(session, CACHED_TOOL, { limit: 1, unusedProbe: "e2e" });
      expect(probed.isError, `extra-argument call failed: ${probed.text}`).toBeFalsy();
      expect(await hitsFor(USERS_PATH), "an unknown extra argument changes the cache key").toBe(before + 3);

      // Argument ORDER cannot split an entry, though: `cacheKey` runs args
      // through `stableStringify`, which sorts object keys at every level.
      const reordered = await callTool(session, CACHED_TOOL, { unusedProbe: "e2e", limit: 1 });
      expect(reordered.text).toBe(probed.text);
      expect(await hitsFor(USERS_PATH), "the cache key is canonicalised, so arg order cannot split an entry").toBe(
        before + 3,
      );
    });
  });

  test("a cached entry stops being served once its TTL elapses", async () => {
    // The TTL unit is SECONDS and the validator's floor is 1, so a real expiry
    // is observable in a couple of seconds — no need to skip this scenario or to
    // raise the 30s per-test timeout for it.
    await patchTool(CACHED_TOOL, { cache: { enabled: true, ttlSeconds: SHORT_TTL_SECONDS } });

    await withSession(async (session) => {
      const before = await hitsFor(USERS_PATH);

      const cold = await callTool(session, CACHED_TOOL);
      expect(cold.isError, `cold call failed: ${cold.text}`).toBeFalsy();
      expect(await hitsFor(USERS_PATH)).toBe(before + 1);

      // Still inside the TTL: served from cache.
      await callTool(session, CACHED_TOOL);
      expect(await hitsFor(USERS_PATH), "a call inside the TTL must still be a hit").toBe(before + 1);

      await sleep(TTL_EXPIRY_WAIT_MS);

      const afterExpiry = await callTool(session, CACHED_TOOL);
      expect(afterExpiry.isError, `post-expiry call failed: ${afterExpiry.text}`).toBeFalsy();
      expect(await hitsFor(USERS_PATH), "an expired entry must be refetched from the upstream").toBe(before + 2);
      // Refetched, not resurrected: same real payload, freshly fetched.
      expect(afterExpiry.text).toBe(cold.text);
    });
  });

  test("caching is off by default — an unconfigured tool hits the upstream every time", async () => {
    // `echo` on this same client is never PATCHed with a cache policy. This is
    // the control that stops every assertion above from passing vacuously, and
    // it simultaneously pins the per-TOOL scope of `tool_cache`: opting
    // `list-users` in above must not opt its siblings in.
    await withSession(async (session) => {
      const before = await hitsFor(ECHO_PATH);

      for (let i = 1; i <= UNCACHED_CALLS; i++) {
        const call = await callTool(session, UNCACHED_TOOL);
        expect(call.status).toBe(200);
        expect(call.isError, `uncached call ${i} failed: ${call.text}`).toBeFalsy();
      }

      expect(await hitsFor(ECHO_PATH), "every call to an unconfigured tool must reach the upstream").toBe(
        before + UNCACHED_CALLS,
      );
    });
  });

  test("an admin cache purge forces the next call back to the upstream", async () => {
    await patchTool(CACHED_TOOL, { cache: { enabled: true, ttlSeconds: LONG_TTL_SECONDS } });

    await withSession(async (session) => {
      const before = await hitsFor(USERS_PATH);

      const cold = await callTool(session, CACHED_TOOL);
      expect(cold.isError, `cold call failed: ${cold.text}`).toBeFalsy();
      await callTool(session, CACHED_TOOL);
      expect(await hitsFor(USERS_PATH), "precondition: the entry is warm").toBe(before + 1);

      // The manual purge (`requireOperator`). The TTL here is 300s, so nothing
      // but this endpoint could put the next call back on the wire.
      const purge = await request.post(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${CACHED_TOOL}/cache/purge`, {
        headers: apiHeaders(auth),
      });
      expect(purge.status(), `purge failed: ${await purge.text()}`).toBe(200);
      const purgeBody = (await purge.json()) as { status: string; name: string; tool: string };
      expect(purgeBody).toEqual({ status: "purged", name: SERVER, tool: CACHED_TOOL });

      const afterPurge = await callTool(session, CACHED_TOOL);
      expect(afterPurge.isError, `post-purge call failed: ${afterPurge.text}`).toBeFalsy();
      expect(await hitsFor(USERS_PATH), "a purged entry must be refetched from the upstream").toBe(before + 2);
      expect(afterPurge.text).toBe(cold.text);
    });
  });

  test("coalescing is off by default — concurrent identical calls each reach the upstream", async () => {
    // The control for the collapse test below: without it, "one upstream hit for
    // N concurrent calls" could be some other layer deduping rather than
    // `runCoalesced`. Setting `enabled: false` is also the documented way to
    // clear the policy — `setToolCoalesce` DELETEs the row for both `null` and
    // `{ enabled: false }`, so a disabled tool is stored as row ABSENCE, never as
    // a persisted `false`.
    await patchTool(SLOW_TOOL, { coalesce: { enabled: false } });
    expect(await coalesceConfigOf(SLOW_TOOL), "a disabled coalesce policy is stored as an absent row").toBeUndefined();

    const argSets = Array.from({ length: COALESCED_CALLERS }, () => ({ ms: SLOW_MS }));
    const before = await hitsFor(SLOW_PATH);
    const results = await callConcurrently(SLOW_TOOL, argSets);

    expect(await hitsFor(SLOW_PATH), "unconfigured: every concurrent caller must reach the upstream").toBe(
      before + COALESCED_CALLERS,
    );
    for (const [i, result] of results.entries()) {
      expect(result.isError, `caller ${i} failed: ${result.text}`).toBeFalsy();
      // Whitespace-tolerant: the bridge pretty-prints the upstream JSON into the
      // MCP text content, so a compact `"sleptMs":1200` substring never matches.
      expect(result.text).toMatch(new RegExp(`"sleptMs":\\s*${SLOW_MS}`));
    }
  });

  test("coalescing collapses concurrent identical calls into ONE upstream request", async () => {
    await patchTool(SLOW_TOOL, { coalesce: { enabled: true } });
    // Unlike `cache`, this policy round-trips into the operator-visible detail view.
    expect(await coalesceConfigOf(SLOW_TOOL)).toEqual({ enabled: true });

    const argSets = Array.from({ length: COALESCED_CALLERS }, () => ({ ms: SLOW_MS }));
    const before = await hitsFor(SLOW_PATH);
    const results = await callConcurrently(SLOW_TOOL, argSets);

    // Same N callers as the control test above, same arguments, one upstream request.
    expect(await hitsFor(SLOW_PATH), "N concurrent identical calls must collapse into one upstream request").toBe(
      before + 1,
    );

    // The other half, and the one a hit count can never show: EVERY caller was
    // answered, and answered with the real upstream payload. An implementation
    // that collapsed the requests but resolved only the leader — or resolved the
    // piggybackers with an empty result — would be indistinguishable above.
    expect(results).toHaveLength(COALESCED_CALLERS);
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe(200);
      expect(result.isError, `piggybacking caller ${i} got an error: ${result.text}`).toBeFalsy();
      expect(result.text, `caller ${i} got no payload`).toMatch(/"status":\s*"ok"/);
      expect(result.text, `caller ${i} got the wrong payload`).toMatch(new RegExp(`"sleptMs":\\s*${SLOW_MS}`));
    }
  });

  test("coalescing does not collapse concurrent calls with different arguments", async () => {
    // Coalescing is still enabled from the test above (serial), which is the
    // point: the same policy that collapsed identical calls must not merge calls
    // that differ. `coalesceKey` is `cacheKey`, so distinct args are distinct
    // keys and each one is its own in-flight entry.
    expect(await coalesceConfigOf(SLOW_TOOL), "precondition: coalescing is still on").toEqual({ enabled: true });

    const argSets = DISTINCT_SLEEP_MS.map((ms) => ({ ms }));
    const before = await hitsFor(SLOW_PATH);
    const results = await callConcurrently(SLOW_TOOL, argSets);

    expect(await hitsFor(SLOW_PATH), "distinct arguments must each reach the upstream").toBe(
      before + DISTINCT_SLEEP_MS.length,
    );

    // And each caller got ITS OWN answer, not a neighbour's: the fixture echoes
    // the `ms` it actually slept, so a wrongly-merged pair would surface here as
    // two callers reporting the same `sleptMs`.
    for (const [i, result] of results.entries()) {
      expect(result.isError, `caller ${i} failed: ${result.text}`).toBeFalsy();
      expect(result.text, `caller ${i} was answered with another caller's response`).toMatch(
        new RegExp(`"sleptMs":\\s*${DISTINCT_SLEEP_MS[i]}`),
      );
    }
  });
});
