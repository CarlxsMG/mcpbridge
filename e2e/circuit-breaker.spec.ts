/**
 * End-to-end test for the per-client circuit breaker.
 *
 * Drives the full `closed -> open -> half_open -> closed` state machine of
 * `src/middleware/circuit-breaker.ts` through the real MCP data plane, against
 * a real upstream that really starts failing — nothing here is stubbed.
 *
 * The four things this pins that a unit test around `CircuitBreaker` cannot:
 *
 *   1. A non-2xx HTTP response counts as a breaker failure. The breaker only
 *      ever sees `recordFailure()`, and it is `dispatch-rest.ts`'s job to call
 *      it for a 500 that never threw — a real past bug class, and the reason
 *      the fixture answers 500 rather than dropping the connection. (500 is
 *      also NOT in dispatch-rest's RETRYABLE_STATUSES, so one failing tool
 *      call is exactly one upstream request; the hit-count deltas below
 *      depend on that.)
 *   2. An OPEN breaker does not dial the upstream at all. Asserted with the
 *      fixture's per-path hit counter, not with the error text: a breaker that
 *      returns an error but still makes the call protects nothing, and only
 *      the hit count can tell the two apart.
 *   3. The breaker is keyed per CLIENT (`getCircuitBreaker(client.name, ...)`),
 *      so a second, healthy backend keeps serving while the first is tripped.
 *   4. The state is observable to an operator via `GET /admin-api/clients/:name`
 *      (`circuitBreakerState`), which is what the admin UI renders.
 *
 * Mechanics worth knowing while reading:
 *
 *   - The fixture's `/health` deliberately stays 200 while `/api/v1/flaky` is
 *     down. The bridge's background health loop evicts unhealthy clients, and
 *     an evicted client would vanish before its breaker could trip.
 *   - The breaker config comes from this spec, not from the ambient
 *     `CIRCUIT_BREAKER_FAILURE_THRESHOLD` env: `PATCH /admin-api/clients/:name`
 *     with `{ guards: { circuitBreaker: { failureThreshold, resetTimeoutMs,
 *     halfOpenTimeoutMs, windowMs } } }`.
 *   - Recovery does not sleep out a long reset timeout. The breaker opens under
 *     a deliberately long `resetTimeoutMs`, which keeps it observably OPEN for
 *     the middle tests; the recovery test then PATCHes the timeout down to ~1s.
 *     `updateCircuitBreakerConfig` applies an edited guard to a LIVE breaker
 *     prospectively and explicitly does NOT reset its state, so the breaker is
 *     still open — only the deadline it measures `lastFailureTime` against
 *     moves. `expect.poll` then waits for the transition instead of a bare
 *     sleep.
 *
 * `.serial`: this file is one state machine walked in order (trip it, observe
 * it open, recover it). Without serial mode a failure in the middle cascades
 * into every later test with unrelated-looking errors.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import {
  apiHeaders,
  deleteClient,
  fixtureControl,
  fixtureState,
  loginAs,
  mintMcpKey,
  registerViaApi,
  type AdminAuth,
} from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall, type McpCallResult } from "./support/mcp";

/** The client whose breaker gets tripped. Registered against the e2e-only extended OpenAPI doc. */
const FAILING_SERVER = "e2e-breaker-flaky-api";
/** A second client on the same fixture, used to prove the breaker is per-client and not global. */
const HEALTHY_SERVER = "e2e-breaker-healthy-api";

/** Fixture paths, as they appear in the control channel's hit counter. */
const FLAKY_PATH = "/api/v1/flaky";
const USERS_PATH = "/api/v1/users";

/** Breaker policy this spec pins on FAILING_SERVER (never the ambient env default). */
const FAILURE_THRESHOLD = 2;
/** Long enough that the breaker stays observably OPEN across the middle tests. */
const OPEN_RESET_TIMEOUT_MS = 60_000;
/** Patched in for the recovery test so half_open is reached without a long sleep. */
const RECOVERY_RESET_TIMEOUT_MS = 1_000;
/** Timeout granted to the single half-open probe call — generous, the probe must not time out. */
const HALF_OPEN_TIMEOUT_MS = 5_000;
/** Sliding failure window; wide enough that the threshold failures below always co-exist in it. */
const WINDOW_MS = 60_000;

/** What this spec sends as `guards.circuitBreaker` (all four fields, always). */
interface BreakerGuards {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenTimeoutMs: number;
  windowMs: number;
}

/** The subset of `GET /admin-api/clients/:name` (ClientDetail) this spec reads. */
interface ClientDetailView {
  name: string;
  live: boolean;
  circuitBreakerState: string | null;
  retryNonSafeMethods: boolean;
  guards?: { circuitBreaker?: Partial<BreakerGuards> };
}

let page: Page;
let request: APIRequestContext;
let auth: AdminAuth;
/** Managed MCP key — the data plane is fail-closed once any key exists, so every call carries it. */
let authHeader: string;

/**
 * Send all four breaker fields every time. `validateClientGuardInput` copies
 * only the fields present in the body, and `setClientGuardsMutation` persists
 * NULL for the absent ones — a partial PATCH would silently drop the rest of
 * the policy from the DB even though the live breaker merges.
 */
async function setBreakerGuards(serverName: string, resetTimeoutMs: number): Promise<void> {
  const circuitBreaker: BreakerGuards = {
    failureThreshold: FAILURE_THRESHOLD,
    resetTimeoutMs,
    halfOpenTimeoutMs: HALF_OPEN_TIMEOUT_MS,
    windowMs: WINDOW_MS,
  };
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${serverName}`, {
    headers: apiHeaders(auth),
    data: { guards: { circuitBreaker } },
  });
  expect(res.status(), `set breaker guards failed: ${await res.text()}`).toBe(200);
}

async function clientDetail(serverName: string): Promise<ClientDetailView> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${serverName}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client detail failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as ClientDetailView;
}

/** The operator-visible breaker state. `getState()` is a pure read — polling it never transitions it. */
async function breakerState(serverName: string): Promise<string | null> {
  return (await clientDetail(serverName)).circuitBreakerState;
}

/** How many times the fixture has been asked for `path`, ever. Only deltas are meaningful. */
async function hitsFor(path: string): Promise<number> {
  const { hits } = await fixtureState(request);
  return hits[path] ?? 0;
}

/**
 * One tool call over the data plane, with its own MCP session (the other specs
 * do the same — a session is per-client and reusing one across tests races with
 * whatever else the serial worker is running).
 */
async function callTool(serverName: string, toolName: string): Promise<McpCallResult> {
  const dataPlane = `/mcp/${serverName}`;
  const { sessionId } = await initMcpSession(dataPlane, { authHeader, clientName: "e2e-breaker" });
  return mcpToolsCall(dataPlane, sessionId, `${serverName}__${toolName}`, authHeader);
}

test.describe.serial("per-client circuit breaker — trip, fail fast, isolate, recover", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Start from a known fixture state — a previous run that died mid-spec
    // could have left the flaky endpoint marked down.
    await fixtureControl(request, "up");

    // Delete-then-register rather than tolerating the 409 from a reused server:
    // `registry.forgetClient` calls `removeCircuitBreaker`, so this is also the
    // only way to guarantee a CLOSED breaker on a local re-run (breaker state is
    // in-memory and deliberately survives everything short of unregistration).
    await deleteClient(request, auth, FAILING_SERVER);
    await deleteClient(request, auth, HEALTHY_SERVER);
    await registerViaApi(request, auth, FAILING_SERVER, FIXTURE_OPENAPI_EXTENDED_PATH);
    await registerViaApi(request, auth, HEALTHY_SERVER, FIXTURE_OPENAPI_EXTENDED_PATH);

    authHeader = (await mintMcpKey(request, auth, "e2e-breaker")).authHeader;

    // Pin the policy on the client under test. The breaker itself is created
    // lazily on the first dispatch, from `client.guards.circuitBreaker` — so
    // this must land before the first tool call. HEALTHY_SERVER is left on the
    // ambient default on purpose: it never fails, and leaving it alone keeps
    // the isolation assertion about the breaker map, not about config.
    await setBreakerGuards(FAILING_SERVER, OPEN_RESET_TIMEOUT_MS);
  });

  test.afterAll(async () => {
    // CRITICAL: the fixture's "down" flag is process-global — every other spec's
    // tool calls go through the same fixture. Leaving it down would cascade
    // failures across the whole suite, so restore it FIRST and unconditionally
    // (afterAll runs even when a test above failed or serial mode skipped the
    // recovery test that would otherwise have restored it).
    try {
      await fixtureControl(request, "up");
      // Dropping the clients drops their breakers with them, so a local re-run
      // (reuseExistingServer) doesn't meet the OPEN breaker this spec leaves.
      await deleteClient(request, auth, FAILING_SERVER);
      await deleteClient(request, auth, HEALTHY_SERVER);
    } finally {
      // After the fixture restore, not before it: the sweep is best-effort and
      // never throws, but the "up" flag is the one thing whose failure would
      // cascade into every later spec, so nothing may be sequenced ahead of it.
      await closeTrackedMcpSessions();
      await page.close();
    }
  });

  test("baseline: the tool succeeds and the breaker reports closed", async () => {
    const before = await hitsFor(FLAKY_PATH);
    const call = await callTool(FAILING_SERVER, "flaky");

    expect(call.status).toBe(200);
    expect(call.isError, `baseline call failed: ${call.text}`).toBeFalsy();
    // Whitespace-tolerant on purpose: the bridge pretty-prints the upstream JSON
    // into the MCP text content, so a compact `"status":"ok"` substring never
    // matches. Don't "simplify" this back to toContain.
    expect(call.text).toMatch(/"status":\s*"ok"/);
    // The call really went to the upstream (nothing cached/mocked in between).
    expect(await hitsFor(FLAKY_PATH), "the baseline call must reach the upstream").toBe(before + 1);

    const detail = await clientDetail(FAILING_SERVER);
    expect(detail.circuitBreakerState).toBe("closed");
    // The policy from beforeAll round-tripped through the DB into the detail view.
    expect(detail.guards?.circuitBreaker?.failureThreshold).toBe(FAILURE_THRESHOLD);
    expect(detail.guards?.circuitBreaker?.resetTimeoutMs).toBe(OPEN_RESET_TIMEOUT_MS);
  });

  test("repeated upstream 500s open the breaker (a non-2xx counts as a failure)", async () => {
    await fixtureControl(request, "down");

    for (let i = 1; i <= FAILURE_THRESHOLD; i++) {
      const before = await hitsFor(FLAKY_PATH);
      const call = await callTool(FAILING_SERVER, "flaky");

      // The upstream 500 surfaces as an isError MCP result, not a transport error.
      expect(call.status).toBe(200);
      expect(call.isError, `call ${i} should have failed`).toBe(true);
      expect(call.text).toContain("500");
      // Still a real upstream failure, NOT a breaker refusal: the breaker only
      // opens once the last of these failures is recorded.
      expect(call.text, `call ${i} was refused instead of dialling the upstream`).not.toMatch(/circuit breaker/i);
      // Exactly one upstream request per call — 500 is not a retryable status,
      // so the failure count the breaker sees equals the call count.
      expect(await hitsFor(FLAKY_PATH), `call ${i} must hit the upstream exactly once`).toBe(before + 1);
    }

    // Reaching the threshold flips the breaker synchronously with the last call.
    expect(await breakerState(FAILING_SERVER)).toBe("open");
  });

  test("once open, calls fail fast WITHOUT reaching the upstream", async () => {
    const before = await hitsFor(FLAKY_PATH);
    const call = await callTool(FAILING_SERVER, "flaky");

    expect(call.status).toBe(200);
    expect(call.isError).toBe(true);
    expect(call.text).toMatch(/circuit breaker open/i);
    expect(call.text).toContain(FAILING_SERVER);

    // The assertion that actually proves the breaker is doing its job: a breaker
    // that returns an error but still dials the upstream provides no protection,
    // and the error text alone cannot distinguish the two.
    expect(await hitsFor(FLAKY_PATH), "an open breaker must not touch the upstream").toBe(before);
  });

  test("the open breaker is observable to an admin, and the client is still live", async () => {
    const detail = await clientDetail(FAILING_SERVER);

    expect(detail.name).toBe(FAILING_SERVER);
    expect(detail.circuitBreakerState).toBe("open");
    // The client was NOT evicted: the fixture keeps /health at 200 while the
    // tool endpoint 500s, precisely so the health loop can't remove the client
    // out from under its own breaker. `circuitBreakerState` is null for a
    // non-live client, so the assertion above already depends on this.
    expect(detail.live).toBe(true);

    // Note: the breaker state lives on the DETAIL endpoint only — the
    // `GET /admin-api/clients` summary intentionally doesn't carry it.
  });

  test("the breaker is per-client: a second healthy backend keeps serving", async () => {
    // Precondition: the first client is still tripped.
    expect(await breakerState(FAILING_SERVER)).toBe("open");

    const before = await hitsFor(USERS_PATH);
    const call = await callTool(HEALTHY_SERVER, "list-users");

    expect(call.status).toBe(200);
    expect(call.isError, `healthy client call failed: ${call.text}`).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
    // And it genuinely reached the upstream while the other client's breaker was
    // open — the mirror image of the fail-fast assertion above.
    expect(await hitsFor(USERS_PATH), "the healthy client must still reach the upstream").toBe(before + 1);

    expect(await breakerState(HEALTHY_SERVER)).toBe("closed");
  });

  test("recovery: the reset timeout elapses -> half_open probe succeeds -> closed", async () => {
    await fixtureControl(request, "up");

    // Move the deadline instead of sleeping out OPEN_RESET_TIMEOUT_MS.
    // `updateCircuitBreakerConfig` mutates only the live breaker's thresholds —
    // its state, probe flag and failure window are explicitly untouched — so the
    // breaker is still OPEN here, just with a reset deadline already in the past.
    await setBreakerGuards(FAILING_SERVER, RECOVERY_RESET_TIMEOUT_MS);

    await expect
      .poll(async () => breakerState(FAILING_SERVER), {
        message: "breaker should report half_open once the reset timeout has elapsed",
        timeout: 15_000,
      })
      .toBe("half_open");

    // The half-open probe: exactly one call is admitted through, it reaches the
    // (now healthy) upstream, and its success closes the breaker.
    const before = await hitsFor(FLAKY_PATH);
    const probe = await callTool(FAILING_SERVER, "flaky");
    expect(probe.status).toBe(200);
    expect(probe.isError, `half-open probe failed: ${probe.text}`).toBeFalsy();
    expect(probe.text).toMatch(/"status":\s*"ok"/);
    expect(await hitsFor(FLAKY_PATH), "the half-open probe must reach the upstream").toBe(before + 1);

    await expect
      .poll(async () => breakerState(FAILING_SERVER), {
        message: "a successful probe should close the breaker",
        timeout: 10_000,
      })
      .toBe("closed");

    // Fully recovered: normal traffic flows again, no probe slot involved.
    const after = await callTool(FAILING_SERVER, "flaky");
    expect(after.isError, `post-recovery call failed: ${after.text}`).toBeFalsy();
    expect(after.text).toMatch(/"status":\s*"ok"/);
  });

  test("retry policy: non-safe methods are not retried by default", async () => {
    // The cheap, real half of the documented invariant — "PUT/DELETE are retried
    // only when the client opts in via retry_non_safe_methods (off by default)".
    // The flag is per-client and surfaced on the detail view.
    const detail = await clientDetail(FAILING_SERVER);
    expect(detail.retryNonSafeMethods).toBe(false);

    // The other half — that a POST/PATCH is never retried even for a RETRYABLE
    // status — is deliberately NOT driven end-to-end here: dispatch-rest only
    // retries 408/429/502/503/504, and the shared fixture exposes no endpoint
    // that answers one of those for a non-safe method, so proving it would mean
    // changing e2e/support/fixture-server.ts (owned elsewhere). What IS pinned
    // above is the adjacent guarantee that makes the failure counting exact:
    // every failing `flaky` call produced exactly one upstream hit, so the
    // non-retryable 500 was attempted once and once only.
  });
});
