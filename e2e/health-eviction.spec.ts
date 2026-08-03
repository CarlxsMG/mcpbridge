/**
 * End-to-end test for health-driven auto-eviction and recovery.
 *
 * Drives the background health-check loop (`src/observability/health.ts`)
 * against a real upstream whose health endpoint really starts answering 503,
 * and pins the distinction that makes eviction *recoverable*: it tears down the
 * LIVE registry entry only, and deliberately never touches the client's SQLite
 * row (`registry.evictUnhealthy` -> `teardownLiveClient`, same teardown as
 * `unregister()`, no `DELETE FROM clients`). Every admin-visible consequence
 * follows from that one split:
 *
 *   - `GET /admin-api/clients/:name` still answers **200**, because
 *     `getClientDetailReadModel` reads the row from SQLite and only *merges*
 *     live state on top. The evicted client keeps its `enabled` flag, its urls,
 *     its pinned `resolvedIp` and its full tool list (read from the `tools`
 *     table on the not-live branch).
 *   - Everything sourced from the live map goes null, not stale:
 *     `live: false`, `status: null`, `circuitBreakerState: null`,
 *     `consecutiveFailures: null`. `status` is the one that surprises — the
 *     loop *does* `markClientStatus(name, "unreachable")` immediately before
 *     evicting, but the eviction then drops the record, and the read model
 *     computes `live?.status ?? null`. So "unreachable" is a *pre*-eviction
 *     state; the observable for "evicted" is `live === false`.
 *   - The data plane stops existing: `POST /mcp/:clientName` answers 404
 *     `CLIENT_NOT_FOUND` (transports.ts's `scopeNotFound` -> `registry.getClient`).
 *
 * Recovery is **NOT automatic** — asserted below rather than assumed:
 *
 *   - The health loop iterates `registry.listClients()`, i.e. the live map. An
 *     evicted client is no longer in it, so it is never probed again. That is
 *     directly observable: the fixture's `/health-toggle` hit counter FREEZES
 *     the moment the client is evicted, while the second client's `/health`
 *     counter keeps advancing on every tick.
 *   - `reconcileFromDb()` is the only other path that could re-hydrate a
 *     DB-only name, and it is doubly blocked: it is opt-in via `REGISTRY_SYNC`
 *     (unset in the e2e env, so the loop never runs at all), and it explicitly
 *     `continue`s over any name in the registry's `healthEvicted` set — the
 *     "health-eviction hold" that exists precisely to stop a
 *     resurrect-then-re-evict loop.
 *   - The hold is cleared by exactly one thing: a genuine re-registration
 *     (`register()`/`registerMcp()` both `healthEvicted.delete(name)` first).
 *     `POST /register` over an existing name replaces the entry rather than
 *     409ing (see openapi.yaml on /register), so re-registering is the
 *     supported recovery action, and it is what this spec drives.
 *
 * What is deliberately NOT asserted, and why:
 *
 *   - `mcp_health_evictions_total` (metrics.ts) really is incremented on
 *     eviction, but `GET /metrics` 404s whenever `config.metricsEnabled` is
 *     false, and playwright.config.ts sets `METRICS_ENABLED: "false"`. The
 *     adjacent `GET /metrics/legacy` has no such gate, so the eviction is still
 *     pinned against an operator-facing metrics surface below, via
 *     `registered_clients.total` (which counts `registry.listClients()`).
 *   - Eviction is **not** audited — `health.ts` writes a `log("warn", ...)` line
 *     and nothing else; it imports no audit module. Don't go looking for an
 *     audit row.
 *   - The `client_unreachable` alert rule (observability/alerts.ts) is not
 *     driven here: it needs a webhook receiver the shared fixture doesn't
 *     provide, and it is edge-triggered on `status === "unreachable"` — a state
 *     that exists for ~3s before eviction removes the client, evaluated by a
 *     loop that ticks every 30s. Racing those two is inherently flaky.
 *
 * `.serial`: one lifecycle walked in order (live -> evicted -> still
 * configured -> isolated -> recovered). Without serial mode a failure in the
 * middle cascades into every later test with unrelated-looking errors.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  APP_BASE_URL,
  FIXTURE_BASE_URL,
  FIXTURE_CONTROL_PATH,
  FIXTURE_HEALTH_TOGGLE_PATH,
  FIXTURE_OPENAPI_EXTENDED_PATH,
} from "./support/env";
import { apiHeaders, deleteClient, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall, type McpCallResult } from "./support/mcp";

/** The client that gets evicted — the ONLY client in the suite pointed at `/health-toggle`. */
const EVICTABLE_SERVER = "e2e-evict-toggle-api";
/** A second client on the same fixture, pointed at plain `/health`, used to prove eviction is per-client. */
const STABLE_SERVER = "e2e-evict-stable-api";

/**
 * The health endpoint every OTHER client in the suite (including STABLE_SERVER,
 * via `registerViaApi`) is registered against. It is UNCONDITIONALLY 200 — the
 * fixture's health-down flag only affects `/health-toggle`.
 *
 * That asymmetry is the whole reason this spec is safe to run inside a shared
 * suite, and it is load-bearing: do NOT "simplify" this spec onto `/health`.
 * Doing so would make the background loop evict every client every other spec
 * registered, and the resulting failures would look nothing like their cause.
 */
const STABLE_HEALTH_PATH = "/health";

/** Mirrors playwright.config.ts's `HEALTH_CHECK_INTERVAL_MS`. */
const HEALTH_CHECK_INTERVAL_MS = 1_500;
/** Backend default (`config.maxConsecutiveFailures`); playwright.config.ts does not override it. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Budget for the eviction to land. Worst case the flip lands just after a tick,
 * so it costs one wasted interval plus MAX_CONSECUTIVE_FAILURES more — ~6s.
 * Multiplied out generously: a slow CI box must not turn a real pass into a
 * timeout, and a genuinely broken eviction fails at the end of this either way.
 */
const EVICTION_TIMEOUT_MS = HEALTH_CHECK_INTERVAL_MS * (MAX_CONSECUTIVE_FAILURES + 1) * 4;

/** Tool dispatched to prove a client is actually serving. Present in both OpenAPI fixtures. */
const PROBE_TOOL = "list-users";

/** The subset of `GET /admin-api/clients/:name` (ClientDetail) this spec reads. */
interface ClientDetailView {
  name: string;
  enabled: boolean;
  live: boolean;
  status: string | null;
  healthUrl: string;
  baseUrl: string;
  resolvedIp: string | null;
  retryNonSafeMethods: boolean;
  consecutiveFailures: number | null;
  circuitBreakerState: string | null;
  kind: string;
  tools: { name: string }[];
}

/** The subset of one `GET /admin-api/clients` row (ClientSummary) this spec reads. */
interface ClientSummaryView {
  name: string;
  enabled: boolean;
  live: boolean;
  status: string | null;
  toolsCount: number;
  healthUrl: string;
}

/** The subset of `GET /metrics/legacy` this spec reads. */
interface LegacyMetricsView {
  registered_clients: { total: number; healthy: number; unreachable: number };
}

/**
 * The fixture's `/__control/state` payload, typed locally.
 *
 * `fixtureState()` in support/admin.ts hits the same endpoint but declares a
 * return type without `healthDown` (the fixture does send it) — and
 * `e2e/support/*` is off-limits to this spec, so the field is re-declared here
 * rather than widened there.
 */
interface FixtureStateView {
  healthDown: boolean;
  hits: Record<string, number>;
}

let page: Page;
let request: APIRequestContext;
let auth: AdminAuth;
/** Managed MCP key — the data plane is fail-closed once any key exists, so every call carries it. */
let authHeader: string;

// ── Fixture control (bare fetch, on purpose) ────────────────────────────────

/**
 * Toggle the fixture's `/health-toggle` endpoint.
 *
 * Bare `fetch` rather than the Playwright `APIRequestContext`, unlike every
 * other helper here: this is the one call whose failure would leak
 * process-global state into later spec files, and it has to work from
 * `afterAll` even if the browser context is already unusable. Nothing about it
 * needs the browser's cookie jar — the fixture control channel is unauthenticated.
 */
async function setFixtureHealth(action: "health-down" | "health-up"): Promise<void> {
  const res = await fetch(`${FIXTURE_BASE_URL}${FIXTURE_CONTROL_PATH}/${action}`, { method: "POST" });
  if (res.status !== 200) {
    throw new Error(`fixture control ${action} failed: ${res.status}`);
  }
}

async function fixtureStateWithHealth(): Promise<FixtureStateView> {
  const res = await fetch(`${FIXTURE_BASE_URL}${FIXTURE_CONTROL_PATH}/state`);
  if (res.status !== 200) {
    throw new Error(`fixture state read failed: ${res.status}`);
  }
  return (await res.json()) as FixtureStateView;
}

/** How many times the fixture has been asked for `path`, ever. Only deltas are meaningful. */
async function fixtureHits(path: string): Promise<number> {
  const { hits } = await fixtureStateWithHealth();
  return hits[path] ?? 0;
}

// ── Admin API reads ─────────────────────────────────────────────────────────

async function clientDetail(serverName: string): Promise<ClientDetailView> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${serverName}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client detail failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as ClientDetailView;
}

/**
 * One client's row out of the paginated summary listing, or undefined.
 * Filtered server-side with `?q=` — the default page is 50 clients and the
 * suite accumulates more than that across spec files.
 */
async function clientSummary(serverName: string): Promise<ClientSummaryView | undefined> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients?q=${serverName}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client list failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { items: ClientSummaryView[] };
  return body.items.find((c) => c.name === serverName);
}

/**
 * Number of clients in the LIVE registry, as an operator sees it.
 *
 * `/metrics/legacy` counts `registry.listClients()` and — unlike `/metrics` —
 * carries no `metricsEnabled` gate, so it is the only metrics surface available
 * in this env (see the header note on `METRICS_ENABLED`).
 */
async function liveClientCount(): Promise<number> {
  const res = await request.get(`${APP_BASE_URL}/metrics/legacy`, { headers: apiHeaders(auth) });
  expect(res.status(), `metrics/legacy failed: ${await res.text()}`).toBe(200);
  return ((await res.json()) as LegacyMetricsView).registered_clients.total;
}

// ── Registration + dispatch ─────────────────────────────────────────────────

/**
 * Register the fixture pointed at `/health-toggle`.
 *
 * A local helper because `registerViaApi` hardcodes `health_url` to `/health`,
 * and this spec's entire subject is a health endpoint that can fail. Tolerates
 * 409 for symmetry with `registerViaApi`, though `POST /register` in fact
 * replaces an existing REST client rather than rejecting it — which is exactly
 * what the recovery test depends on.
 */
async function registerAgainstHealthToggle(serverName: string): Promise<number> {
  const res = await request.post(`${APP_BASE_URL}/register`, {
    headers: apiHeaders(auth),
    data: {
      name: serverName,
      health_url: `${FIXTURE_BASE_URL}${FIXTURE_HEALTH_TOGGLE_PATH}`,
      base_url: FIXTURE_BASE_URL,
      openapi_url: `${FIXTURE_BASE_URL}${FIXTURE_OPENAPI_EXTENDED_PATH}`,
    },
  });
  expect([200, 201, 409], `register(${serverName}) failed: ${res.status()} ${await res.text()}`).toContain(
    res.status(),
  );
  return res.status();
}

/**
 * One tool call over the data plane, with its own MCP session (the other specs
 * do the same — a session is per-client and reusing one across tests races with
 * whatever else the serial worker is running).
 */
async function callTool(serverName: string, toolName: string): Promise<McpCallResult> {
  const dataPlane = `/mcp/${serverName}`;
  const { sessionId } = await initMcpSession(dataPlane, { authHeader, clientName: "e2e-evict" });
  return mcpToolsCall(dataPlane, sessionId, `${serverName}__${toolName}`, authHeader);
}

/**
 * The raw initialize handshake against a shard, returning the transport-level
 * status instead of throwing on a non-200.
 *
 * `initMcpSession` throws on anything but 200, so it cannot express "the shard
 * itself is gone" — which is precisely the assertion an evicted client needs.
 * Any session that unexpectedly comes back is released immediately: a failed
 * assertion must not also burn one of the process's 100 session slots.
 */
async function initShardRaw(serverName: string): Promise<{ status: number; body: string }> {
  const url = `${APP_BASE_URL}/mcp/${serverName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: authHeader,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-evict", version: "1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const body = await res.text();
  if (sessionId) {
    await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sessionId, authorization: authHeader } });
  }
  return { status: res.status, body };
}

test.describe.serial("health-check auto-eviction — evict, preserve config, isolate, recover", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Start from a known fixture state — a previous run that died mid-spec
    // could have left the toggle marked down.
    await setFixtureHealth("health-up");

    // Delete-then-register rather than tolerating a reused client: `deleteClient`
    // goes to `registry.forgetClient`, which is the one teardown that drops the
    // SQLite row AND clears the health-eviction hold. On a local re-run
    // (`reuseExistingServer`) the previous run may have left this exact name
    // held, and a held name is invisible to reconcile — starting clean is the
    // only way to guarantee the baseline test below sees a live client.
    await deleteClient(request, auth, EVICTABLE_SERVER);
    await deleteClient(request, auth, STABLE_SERVER);

    await registerAgainstHealthToggle(EVICTABLE_SERVER);
    await registerViaApi(request, auth, STABLE_SERVER, FIXTURE_OPENAPI_EXTENDED_PATH);

    authHeader = (await mintMcpKey(request, auth, "e2e-evict")).authHeader;
  });

  test.afterAll(async () => {
    // CRITICAL: the fixture's health-down flag is PROCESS-GLOBAL — it lives in
    // module scope in support/fixture-server.ts and outlives this spec file.
    // Restore it FIRST and unconditionally (afterAll runs even when a test above
    // failed, or when serial mode skipped the recovery test that would otherwise
    // have restored it). The nested try/finally is deliberate: a failure here
    // must not skip the client cleanup, and neither must skip the page close.
    try {
      await setFixtureHealth("health-up");
    } finally {
      try {
        await deleteClient(request, auth, EVICTABLE_SERVER);
        await deleteClient(request, auth, STABLE_SERVER);
      } finally {
        await closeTrackedMcpSessions();
        await page.close();
      }
    }
  });

  test("baseline: both clients are live and their tools dispatch", async () => {
    const detail = await clientDetail(EVICTABLE_SERVER);
    expect(detail.live).toBe(true);
    expect(detail.status).toBe("healthy");
    expect(detail.consecutiveFailures).toBe(0);
    // A live client always reports a breaker state; null means "not live", which
    // is what the eviction assertions below turn on.
    expect(detail.circuitBreakerState).not.toBeNull();
    // Proves this client — and only this client — is wired to the failable
    // endpoint. If this ever reads `/health`, the spec has been "simplified"
    // into something that evicts the whole suite's backends.
    expect(detail.healthUrl).toBe(`${FIXTURE_BASE_URL}${FIXTURE_HEALTH_TOGGLE_PATH}`);

    const stable = await clientDetail(STABLE_SERVER);
    expect(stable.live).toBe(true);
    expect(stable.healthUrl).toBe(`${FIXTURE_BASE_URL}${STABLE_HEALTH_PATH}`);

    const call = await callTool(EVICTABLE_SERVER, PROBE_TOOL);
    expect(call.status).toBe(200);
    expect(call.isError, `baseline call failed: ${call.text}`).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("repeated health failures auto-evict the client from the live registry", async () => {
    // The eviction poll alone can consume most of the 30s default.
    test.setTimeout(90_000);

    const liveBefore = await liveClientCount();

    await setFixtureHealth("health-down");
    expect((await fixtureStateWithHealth()).healthDown, "the fixture did not accept the health-down flip").toBe(true);

    // `live` is the observable, not `status`: the loop marks the client
    // "unreachable" on its way to evicting it, but eviction then drops the live
    // record entirely and the read model reports `live?.status ?? null`.
    await expect
      .poll(async () => (await clientDetail(EVICTABLE_SERVER)).live, {
        message: `${EVICTABLE_SERVER} should be evicted after ${MAX_CONSECUTIVE_FAILURES} consecutive health failures`,
        timeout: EVICTION_TIMEOUT_MS,
        intervals: [500],
      })
      .toBe(false);

    // Everything sourced from the live map goes null — never stale.
    const detail = await clientDetail(EVICTABLE_SERVER);
    expect(detail.status, "status is live?.status ?? null — 'unreachable' is a PRE-eviction state").toBeNull();
    expect(detail.circuitBreakerState).toBeNull();
    expect(detail.consecutiveFailures).toBeNull();

    // Operator-visible through the metrics surface too: the live registry shrank.
    // Asserted as a strict decrease rather than an exact -1 — nothing registers
    // concurrently (workers: 1, and spec FILES run sequentially), but pinning a
    // global count to an exact delta would couple this spec to whatever earlier
    // files happened to leave registered.
    expect(await liveClientCount(), "the evicted client should drop out of the live registry count").toBeLessThan(
      liveBefore,
    );

    // The data plane for that client no longer exists at all — `scopeNotFound`
    // rejects the handshake before a session is ever created.
    const init = await initShardRaw(EVICTABLE_SERVER);
    expect(init.status).toBe(404);
    expect(init.body).toContain("CLIENT_NOT_FOUND");
  });

  test("eviction does NOT delete the configuration — the SQLite row survives intact", async () => {
    // This is the whole point of `evictUnhealthy` sharing `teardownLiveClient`
    // with `unregister()` instead of going through `forgetClient()`: no
    // `DELETE FROM clients`, so an operator's guards/enable state and the
    // discovered tool set outlive an unhealthy backend.
    const detail = await clientDetail(EVICTABLE_SERVER);
    expect(detail.name).toBe(EVICTABLE_SERVER);
    expect(detail.live, "precondition: still evicted").toBe(false);

    // Durable columns, all read straight from the row on the not-live branch.
    expect(detail.enabled, "eviction must not disable the client").toBe(true);
    expect(detail.healthUrl).toBe(`${FIXTURE_BASE_URL}${FIXTURE_HEALTH_TOGGLE_PATH}`);
    expect(detail.baseUrl).toBe(FIXTURE_BASE_URL);
    expect(detail.resolvedIp, "the pinned IP is a durable column, not live state").toBeTruthy();
    expect(detail.kind).toBe("rest");
    expect(detail.retryNonSafeMethods).toBe(false);
    // Tools come from the `tools` table when the client isn't live.
    expect(detail.tools.map((t) => t.name)).toContain(PROBE_TOOL);

    // And it is still listed — an evicted client does not vanish from the admin
    // UI's server list, it appears there as configured-but-not-live.
    const summary = await clientSummary(EVICTABLE_SERVER);
    expect(summary, "an evicted client must still appear in GET /admin-api/clients").toBeDefined();
    expect(summary?.live).toBe(false);
    expect(summary?.status).toBeNull();
    expect(summary?.enabled).toBe(true);
    expect(summary?.toolsCount).toBeGreaterThan(0);
  });

  test("eviction is per-client: the second backend keeps serving throughout", async () => {
    // Still down, still evicted — this test runs inside the outage window.
    expect((await fixtureStateWithHealth()).healthDown).toBe(true);
    expect((await clientDetail(EVICTABLE_SERVER)).live).toBe(false);

    const stable = await clientDetail(STABLE_SERVER);
    expect(stable.live).toBe(true);
    expect(stable.status, "the healthy client must never have been marked unreachable").toBe("healthy");
    expect(stable.consecutiveFailures).toBe(0);

    const call = await callTool(STABLE_SERVER, PROBE_TOOL);
    expect(call.status).toBe(200);
    expect(call.isError, `healthy client call failed: ${call.text}`).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("recovery: health coming back is not enough — re-registration is what restores service", async () => {
    // Waits on several health-loop ticks plus a re-registration round trip.
    test.setTimeout(90_000);

    await setFixtureHealth("health-up");
    expect((await fixtureStateWithHealth()).healthDown).toBe(false);

    const toggleHitsAtEviction = await fixtureHits(FIXTURE_HEALTH_TOGGLE_PATH);
    const stableHitsAtEviction = await fixtureHits(STABLE_HEALTH_PATH);

    // Wait out the loop by watching the STABLE client's probe counter advance,
    // never by sleeping. `checkBatch` probes EVERY live client on each pass, so
    // any advance here proves at least one complete pass happened — and a pass
    // that had the evicted client in `listClients()` would necessarily have hit
    // `/health-toggle` too. Asking for MAX_CONSECUTIVE_FAILURES + 1 rather than
    // 1 buys margin: it is also more probes than it took to evict in the first
    // place, so "it just hasn't been probed enough yet" is ruled out.
    await expect
      .poll(async () => fixtureHits(STABLE_HEALTH_PATH), {
        message: "the health loop should keep probing the still-live client",
        timeout: EVICTION_TIMEOUT_MS,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(stableHitsAtEviction + MAX_CONSECUTIVE_FAILURES + 1);

    // An evicted client is not in `registry.listClients()`, so the loop never
    // probes it again — its counter is frozen, no matter that the endpoint is
    // healthy again.
    expect(await fixtureHits(FIXTURE_HEALTH_TOGGLE_PATH), "the health loop must not probe an evicted client").toBe(
      toggleHitsAtEviction,
    );

    // And nothing re-hydrated it: `reconcileFromDb` is off in this env
    // (REGISTRY_SYNC unset) and would withhold the name anyway while the
    // health-eviction hold is set.
    expect((await clientDetail(EVICTABLE_SERVER)).live, "recovery must NOT be automatic").toBe(false);
    expect((await initShardRaw(EVICTABLE_SERVER)).status).toBe(404);

    // Re-registration is the recovery action: `register()` clears the hold, then
    // puts the client back in the live map as "healthy". It replaces the
    // existing row rather than 409ing on the duplicate name.
    expect(await registerAgainstHealthToggle(EVICTABLE_SERVER)).toBe(200);

    const detail = await clientDetail(EVICTABLE_SERVER);
    expect(detail.live, "a re-registration should bring the client straight back").toBe(true);
    expect(detail.status).toBe("healthy");
    expect(detail.consecutiveFailures).toBe(0);
    expect(detail.circuitBreakerState).not.toBeNull();

    // Back in service end to end.
    const call = await callTool(EVICTABLE_SERVER, PROBE_TOOL);
    expect(call.status).toBe(200);
    expect(call.isError, `post-recovery call failed: ${call.text}`).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");

    // And it is being health-probed again — the counter unfreezes.
    await expect
      .poll(async () => fixtureHits(FIXTURE_HEALTH_TOGGLE_PATH), {
        message: "a re-registered client should re-enter the health loop",
        timeout: EVICTION_TIMEOUT_MS,
        intervals: [500],
      })
      .toBeGreaterThan(toggleHitsAtEviction);

    // The recovered client stays healthy across those ticks — the hold really is
    // gone, rather than the client being re-evicted on the next pass.
    expect((await clientDetail(EVICTABLE_SERVER)).live).toBe(true);
  });
});
