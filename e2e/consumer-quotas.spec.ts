/**
 * End-to-end test for PER-CONSUMER metering: the monthly quota and the opt-in
 * per-end-user rate limit that a consumer (`src/admin/entities/consumers.ts`)
 * imposes on every managed key bound to it.
 *
 * A consumer is the gateway's billing/tenancy unit, and a managed MCP key is
 * the ONLY thing that ties a live call to one — `mcp_api_keys.consumer_id`,
 * set at mint time. So the whole feature is a three-hop chain that no backend
 * unit test can walk end to end:
 *
 *   admin API write -> SQLite -> key resolution at dispatch -> refusal,
 *   and, on the way back, a finished call's telemetry -> the same counter.
 *
 * Backend tests exercise `checkConsumerQuota` / `proxyToolCall` against a
 * hand-built registry and a hand-seeded counter row. What only an e2e can show
 * is that the number an operator PATCHes into `monthlyQuota` and the number
 * `recordUsage` writes while a real proxied call completes are the same number,
 * read through the same key binding, on the wire.
 *
 * Where it is enforced: `checkConsumerQuotaGate` (src/proxy/gates.ts), called
 * from `dispatchToolCall` (src/proxy/proxy.ts) — after the key-scope gate and
 * BEFORE the sensitive-tool gate, the circuit breaker and dispatch itself. Like
 * every other policy here it has to live at the dispatch point rather than in
 * Express middleware: MCP multiplexes every tool over the one
 * `POST /mcp/:clientName` route, and the caller's key (hence its consumer) only
 * becomes actionable once the JSON-RPC body has been parsed.
 *
 * Both refusals are `isError` results inside a 200 JSON-RPC envelope, never a
 * transport error — an agent that spends its quota keeps its session and can
 * report the fact instead of dropping the connection:
 *
 *   - `Monthly quota exceeded for this API key's consumer (<used>/<quota>)`
 *   - `End-user rate limit exceeded — retry after <n>s`
 *
 * TWO SEPARATE FEATURES, both implemented, both covered below:
 *   - `monthlyQuota` — a cumulative ceiling for the UTC calendar month, counted
 *     in `consumer_usage_counters` (migration 55) and read back by
 *     `GET /admin-api/consumers/:id/usage`.
 *   - `endUserRateLimitPerMin` — a 60s FIXED window per caller-asserted end-user
 *     identity (`X-End-User-Id`, or an `__end_user` argument), namespaced per
 *     consumer in the shared `rate_counters` table.
 * There is no third "requests per minute per consumer" knob; the per-minute
 * limiting that exists is the per-TOOL guard, which guard-enforcement.spec.ts
 * already owns.
 *
 * Two mechanics that shape every test below:
 *
 *   - Every ceiling is set RELATIVE to the counter's current value. The monthly
 *     counter is cumulative and survives a local re-run (`reuseExistingServer`
 *     means the spec meets the rows the previous run left), so a hard-coded
 *     `monthlyQuota: 1` would already be exhausted before the first call.
 *   - The refusals are asserted together with the fixture's per-path hit count.
 *     A quota that returns an error only *after* calling the backend has saved
 *     nothing — neither the upstream's capacity nor the money the quota is
 *     denominated in — and the error text alone cannot tell the two apart.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_PATH } from "./support/env";
import {
  apiHeaders,
  createAdminUser,
  fixtureState,
  loginAs,
  mintMcpKey,
  registerViaApi,
  type AdminAuth,
} from "./support/admin";
import {
  closeMcpSession,
  closeTrackedMcpSessions,
  initMcpSession,
  mcpToolsCall,
  parseSseJson,
  type McpCallResult,
} from "./support/mcp";

// ── Fixtures under test ──────────────────────────────────────────────────────

/**
 * One REST backend for every scenario. Unlike guard-enforcement.spec.ts this
 * spec can share a client and a tool across tests: nothing here is keyed on
 * `clientName__toolName`, the meters live on the CONSUMER, and each test brings
 * its own consumer and its own freshly minted key.
 */
const QUOTA_SERVER = "e2e-quota-api";
const DATA_PLANE = `/mcp/${QUOTA_SERVER}`;
/** A plain GET the fixture always answers 200 — nothing here is about the backend failing. */
const TOOL = "list-users";
/** Its upstream path, as it appears in the fixture's hit counter. Only deltas are meaningful. */
const USERS_PATH = "/api/v1/users";

/** One consumer per scenario, so no test depends on what another left behind. */
const ALPHA = "e2e-quota-alpha";
const BETA = "e2e-quota-beta";
const CAPPED = "e2e-quota-capped";
const BLOCKED = "e2e-quota-blocked";
const DOOMED = "e2e-quota-doomed";
const FAIR = "e2e-quota-fair";
const RBAC = "e2e-quota-rbac";
/** Prefix the teardown sweep uses to find this spec's consumers. */
const CONSUMER_PREFIX = "e2e-quota-";

/**
 * The non-admin used for the role test. An OPERATOR, not a viewer, on purpose:
 * an operator already passes `requireOperator` — the bar most mutating admin
 * routes carry — so a refusal on these three can only come from the stricter
 * `requireAdminRole` they actually declare.
 */
const OPERATOR_USERNAME = "e2e-quota-operator";
const OPERATOR_PASSWORD = "e2e-quota-operator-pw-2026"; // >= 12 chars (user-create rule)
/** A recognisable quota on the RBAC subject, so "the refused PATCH changed nothing" is checkable. */
const RBAC_QUOTA = 4242;

/** `checkConsumerQuotaGate`'s per-end-user refusal. The retry hint is the only actionable part for a caller. */
const END_USER_REFUSAL = /^End-user rate limit exceeded — retry after \d+s$/;

let page: Page;
let request: APIRequestContext;
let auth: AdminAuth;

// ── Local helpers (this spec owns them — e2e/support/* belongs to every spec) ─

/** The consumer shape the admin API returns (`rowToConsumer` in admin/entities/consumers.ts). */
interface ConsumerView {
  id: number;
  name: string;
  monthlyQuota: number | null;
  endUserRateLimitPerMin: number | null;
  teamId: number | null;
}

/** `GET /admin-api/consumers` decorates each row with the month's call count. */
interface ConsumerListItem extends ConsumerView {
  usedThisMonth: number;
}

/** `GET /admin-api/consumers/:id/usage`. */
interface UsageView {
  used: number;
  quota: number | null;
}

/** The standard admin-API error envelope (`sendError` in src/routes/http-errors.ts). */
interface ApiErrorBody {
  error: { code: string; message: string; request_id: string | null };
}

/** The subset of `GET /admin-api/mcp-keys/:id` this spec reads. */
interface McpKeyView {
  id: number;
  consumerId: number | null;
}

/** The quota policy a scenario pins on its consumer. Always sent in full — see `ensureConsumer`. */
interface ConsumerPolicy {
  monthlyQuota: number | null;
  endUserRateLimitPerMin: number | null;
}

async function listConsumers(): Promise<ConsumerListItem[]> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/consumers`, { headers: apiHeaders(auth) });
  expect(res.status(), `list consumers failed: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { items: ConsumerListItem[] }).items;
}

async function patchConsumer(id: number, body: Record<string, unknown>): Promise<ConsumerView> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/consumers/${id}`, {
    headers: apiHeaders(auth),
    data: body,
  });
  expect(res.status(), `patch consumer ${id} ${JSON.stringify(body)} failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as ConsumerView;
}

/**
 * Create the consumer, or adopt the one a previous local run left behind, then
 * PATCH the exact policy this scenario depends on over the top. The PATCH is
 * not redundant on the adopt path: a leftover carries whatever quota the last
 * run finished with, and every test below must SET what it asserts on rather
 * than inherit it.
 */
async function ensureConsumer(name: string, policy: ConsumerPolicy): Promise<ConsumerView> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/consumers`, {
    headers: apiHeaders(auth),
    data: { name, ...policy },
  });
  expect([201, 409], `create consumer(${name}) failed: ${res.status()} ${await res.text()}`).toContain(res.status());
  if (res.status() === 201) return (await res.json()) as ConsumerView;

  const existing = (await listConsumers()).find((c) => c.name === name);
  if (!existing) throw new Error(`consumer ${name} reported as existing (409) but is not in the list`);
  return patchConsumer(existing.id, { ...policy });
}

async function consumerUsage(id: number): Promise<UsageView> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/consumers/${id}/usage`, { headers: apiHeaders(auth) });
  expect(res.status(), `usage for consumer ${id} failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as UsageView;
}

/** Just the month's call count — the number the quota gate compares against. */
async function usedBy(id: number): Promise<number> {
  return (await consumerUsage(id)).used;
}

/** Returns the raw status so a caller can also drive the "it's already gone" case. */
async function deleteConsumer(id: number): Promise<number> {
  const res = await request.delete(`${APP_BASE_URL}/admin-api/consumers/${id}`, { headers: apiHeaders(auth) });
  return res.status();
}

async function getMcpKey(id: number): Promise<McpKeyView> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/mcp-keys/${id}`, { headers: apiHeaders(auth) });
  expect(res.status(), `get mcp-key ${id} failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as McpKeyView;
}

/** How many times the fixture has served `list-users`, ever. Only deltas are meaningful. */
async function upstreamHits(): Promise<number> {
  const { hits } = await fixtureState(request);
  return hits[USERS_PATH] ?? 0;
}

/** A managed key bound to a consumer (or to none), plus its open data-plane session. */
interface KeyedSession {
  keyId: number;
  authHeader: string;
  sessionId: string;
}

/**
 * Mint a key for `consumerId` (null = an unattributed key) and open a session
 * with it. A session per key rather than one shared session: the gateway
 * re-reads the bearer on every request, so mixing keys over one session would
 * work — but it would also stop resembling anything a real client does.
 */
async function openKeyedSession(label: string, consumerId: number | null): Promise<KeyedSession> {
  const { id, authHeader } = await mintMcpKey(request, auth, label, { consumerId });
  const { sessionId } = await initMcpSession(DATA_PLANE, { authHeader, clientName: "e2e-quota" });
  return { keyId: id, authHeader, sessionId };
}

/**
 * Hand the session slot back. The gateway caps concurrent sessions at
 * `config.maxSessions` (100) for the whole process and only expires idle ones
 * after a 30-minute TTL, so a spec that leaks simply subtracts from every later
 * spec's headroom.
 */
async function closeKeyedSession(session: KeyedSession): Promise<void> {
  await closeMcpSession(DATA_PLANE, session.sessionId, session.authHeader);
}

/** tools/call for the shared tool, addressed as `client__tool`. */
async function callTool(session: KeyedSession, args: Record<string, unknown> = {}): Promise<McpCallResult> {
  return mcpToolsCall(DATA_PLANE, session.sessionId, `${QUOTA_SERVER}__${TOOL}`, session.authHeader, args);
}

/**
 * The same call, carrying an `X-End-User-Id` header. Hand-rolled here because
 * `support/mcp.ts`'s `mcpToolsCall` sends a fixed header set and belongs to the
 * whole suite — this spec is the only one that needs the extra header, and the
 * header path is precisely what it must prove works over the wire (the value
 * reaches the gate through the SDK's `extra.requestInfo.headers`, which no
 * backend unit test exercises).
 */
async function callToolAsEndUser(session: KeyedSession, endUserId: string): Promise<McpCallResult> {
  const res = await fetch(`${APP_BASE_URL}${DATA_PLANE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId,
      authorization: session.authHeader,
      "x-end-user-id": endUserId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 31,
      params: { name: `${QUOTA_SERVER}__${TOOL}`, arguments: {} },
    }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  const result = parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } | undefined;
  return {
    status: res.status,
    isError: result?.isError,
    text: result?.content?.map((c) => c.text).join("\n"),
  };
}

/** The gate's monthly-quota refusal, built from the ceiling the test pinned. */
function quotaRefusal(cap: number): string {
  return `Monthly quota exceeded for this API key's consumer (${cap}/${cap})`;
}

/**
 * Drive `consumer` to exactly its ceiling and return that ceiling: read what
 * the month has already spent, allow one more call, then spend it. Setting the
 * quota relative to `used` is what makes this work on a re-run against a reused
 * server, and spending the unit with a REAL call is what makes the exhausted
 * state real rather than seeded.
 */
async function exhaustQuota(consumerId: number, session: KeyedSession): Promise<number> {
  const cap = (await usedBy(consumerId)) + 1;
  await patchConsumer(consumerId, { monthlyQuota: cap });
  const lastAllowed = await callTool(session);
  expect(lastAllowed.isError, `the last call under the quota was refused: ${lastAllowed.text}`).toBeFalsy();
  expect(await usedBy(consumerId), "the allowed call should have consumed the quota's last unit").toBe(cap);
  return cap;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test.describe("per-consumer quotas and end-user rate limits are enforced at dispatch", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // The shared OpenAPI fixture is enough — `list-users` is the only tool this
    // spec calls. Registration goes through the API rather than the form:
    // smoke.spec.ts already covers the UI discovery path.
    await registerViaApi(request, auth, QUOTA_SERVER, FIXTURE_OPENAPI_PATH);
  });

  test.afterAll(async () => {
    try {
      // Drop this spec's consumers. The monthly counter is cumulative and
      // outlives a run, so leaving them behind would hand the next local run a
      // partially-spent month — and would leave rows in every other spec's
      // `GET /admin-api/consumers` listing. Their keys survive with
      // `consumer_id` set NULL by the FK, which is harmless.
      for (const item of await listConsumers()) {
        if (item.name.startsWith(CONSUMER_PREFIX)) await deleteConsumer(item.id);
      }
    } finally {
      // Session slots first among the things that must happen regardless: they
      // are process-wide and shared with every later spec.
      await closeTrackedMcpSessions();
      await page.close();
    }
  });

  test("a consumer-bound key's call reaches the upstream and moves that consumer's counter", async () => {
    const consumer = await ensureConsumer(ALPHA, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const session = await openKeyedSession("e2e-quota-alpha-key", consumer.id);
    try {
      const before = await consumerUsage(consumer.id);
      // `quota: null` is "no ceiling", NOT "not counted" — the counter runs
      // regardless, which is what makes a later PATCH able to cap anything.
      expect(before.quota).toBeNull();

      const hitsBefore = await upstreamHits();
      const call = await callTool(session);

      expect(call.status).toBe(200);
      expect(call.isError, `call failed: ${call.text}`).toBeFalsy();
      expect(call.text).toContain("Ada Lovelace");
      // Metering a call that never happened would be worse than not metering:
      // the counter must move because a real round trip completed.
      expect(await upstreamHits(), "the call must really reach the fixture").toBe(hitsBefore + 1);

      const after = await consumerUsage(consumer.id);
      expect(after.used).toBe(before.used + 1);
      expect(after.quota).toBeNull();

      // The list projection computes `usedThisMonth` at its own call site of
      // `getConsumerUsageThisMonth`; pin both readings of the same counter, or
      // the admin UI's table and the quota gate could silently disagree.
      const listed = (await listConsumers()).find((c) => c.id === consumer.id);
      expect(listed?.usedThisMonth).toBe(after.used);
    } finally {
      await closeKeyedSession(session);
    }
  });

  test("an exhausted monthly quota refuses the call WITHOUT reaching the upstream", async () => {
    const consumer = await ensureConsumer(CAPPED, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const session = await openKeyedSession("e2e-quota-capped-key", consumer.id);
    try {
      const cap = await exhaustQuota(consumer.id, session);

      const hitsBefore = await upstreamHits();
      const refused = await callTool(session);

      // A tripped meter is an MCP-level error, not a 429: the transport stays
      // healthy and the session survives, so the caller can report and back off.
      expect(refused.status).toBe(200);
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(quotaRefusal(cap));
      expect(refused.text).not.toContain("Ada Lovelace");
      // The assertion this test exists for: an over-quota call must cost the
      // upstream nothing. An error returned after the backend was already
      // called protects neither capacity nor spend, and the text can't tell.
      expect(await upstreamHits(), "an over-quota call must not touch the upstream").toBe(hitsBefore);
      // …and a refused call is not itself metered. The gate returns before
      // dispatch, so `recordUsage` never runs — otherwise a blocked caller
      // would inflate its own counter forever just by retrying.
      expect(await usedBy(consumer.id), "a refused call must not count against the quota").toBe(cap);

      // Reversible from the admin API alone, on the very next call. "Clear the
      // field" regressions are easy to ship — the write path only ever gets
      // exercised with a value — and they leave an operator with a consumer
      // they cannot unblock short of deleting it.
      await patchConsumer(consumer.id, { monthlyQuota: null });
      const restored = await callTool(session);
      expect(restored.status).toBe(200);
      expect(restored.isError, `still refused after clearing the quota: ${restored.text}`).toBeFalsy();
      expect(restored.text).toContain("Ada Lovelace");
    } finally {
      await closeKeyedSession(session);
    }
  });

  test("usage is charged to the calling key's consumer alone", async () => {
    const alpha = await ensureConsumer(ALPHA, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const beta = await ensureConsumer(BETA, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const alphaSession = await openKeyedSession("e2e-quota-alpha-attrib-key", alpha.id);
    const betaSession = await openKeyedSession("e2e-quota-beta-attrib-key", beta.id);
    try {
      const alphaBefore = await usedBy(alpha.id);
      const betaBefore = await usedBy(beta.id);

      const viaAlpha = await callTool(alphaSession);
      expect(viaAlpha.isError, `alpha's call failed: ${viaAlpha.text}`).toBeFalsy();
      expect(await usedBy(alpha.id)).toBe(alphaBefore + 1);
      expect(await usedBy(beta.id), "beta's counter moved on a call made with alpha's key").toBe(betaBefore);

      // Both directions, deliberately: one direction alone cannot distinguish
      // correct attribution from two counters that are simply swapped.
      const viaBeta = await callTool(betaSession);
      expect(viaBeta.isError, `beta's call failed: ${viaBeta.text}`).toBeFalsy();
      expect(await usedBy(beta.id)).toBe(betaBefore + 1);
      expect(await usedBy(alpha.id), "alpha's counter moved on a call made with beta's key").toBe(alphaBefore + 1);
    } finally {
      await closeKeyedSession(alphaSession);
      await closeKeyedSession(betaSession);
    }
  });

  test("a key with no consumer is unaffected by an exhausted quota", async () => {
    const consumer = await ensureConsumer(BLOCKED, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const bound = await openKeyedSession("e2e-quota-blocked-key", consumer.id);
    // `consumerId: null` is the ordinary case — most managed keys are minted
    // without one, and they must stay outside every consumer's meter.
    const unattributed = await openKeyedSession("e2e-quota-unattributed-key", null);
    try {
      const cap = await exhaustQuota(consumer.id, bound);

      // Establish the precondition rather than assume it: without a genuinely
      // refusing consumer, the assertion below would pass on a broken gate.
      const blocked = await callTool(bound);
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toBe(quotaRefusal(cap));

      const hitsBefore = await upstreamHits();
      const free = await callTool(unattributed);

      expect(free.status).toBe(200);
      expect(free.isError, `a consumerless key was refused: ${free.text}`).toBeFalsy();
      expect(free.text).toContain("Ada Lovelace");
      expect(await upstreamHits(), "the unattributed call must reach the upstream").toBe(hitsBefore + 1);
      // And it is charged to nobody: the gate returns immediately when the
      // caller's key has no `consumerId`, and `recordUsage`'s UPSERT selects no
      // row for such a key — so no other tenant's meter can absorb it either.
      expect(await usedBy(consumer.id), "an unattributed call was charged to a consumer").toBe(cap);
    } finally {
      await closeKeyedSession(bound);
      await closeKeyedSession(unattributed);
    }
  });

  test("deleting a consumer stops its quota being enforced on the very next call", async () => {
    // Delete is the only off switch there is: a consumer row has no
    // `enabled`/`disabled` flag, so "turn this tenant off" is either a DELETE
    // or a quota an operator sets low — the live-edit half of which the
    // exhaustion test above already covers in both directions.
    const consumer = await ensureConsumer(DOOMED, { monthlyQuota: null, endUserRateLimitPerMin: null });
    const session = await openKeyedSession("e2e-quota-doomed-key", consumer.id);
    try {
      const cap = await exhaustQuota(consumer.id, session);
      const refused = await callTool(session);
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(quotaRefusal(cap));

      expect(await deleteConsumer(consumer.id), "delete consumer failed").toBe(200);

      // The KEY survives its consumer: `mcp_api_keys.consumer_id` is
      // `REFERENCES consumers(id) ON DELETE SET NULL` and the connection really
      // issues `PRAGMA foreign_keys = ON`, so the same bearer keeps working —
      // now as an unattributed caller. A regression that instead orphaned the
      // key (dangling id) would still "work" here, which is why the null is
      // asserted directly and not just inferred from the call succeeding.
      expect((await getMcpKey(session.keyId)).consumerId).toBeNull();

      const hitsBefore = await upstreamHits();
      const after = await callTool(session);
      // Deleting a consumer LIFTS its quota rather than blocking its keys —
      // `checkConsumerQuota` treats an unknown consumer as unlimited
      // (fail-open, and documented as such). Pinned here because the opposite
      // choice would be just as defensible, so a silent flip must be visible.
      expect(after.status).toBe(200);
      expect(after.isError, `still refused after deleting the consumer: ${after.text}`).toBeFalsy();
      expect(await upstreamHits(), "the call must reach the upstream once the consumer is gone").toBe(hitsBefore + 1);

      const usage = await request.get(`${APP_BASE_URL}/admin-api/consumers/${consumer.id}/usage`, {
        headers: apiHeaders(auth),
      });
      expect(usage.status()).toBe(404);
      expect(((await usage.json()) as ApiErrorBody).error.code).toBe("CONSUMER_NOT_FOUND");
    } finally {
      await closeKeyedSession(session);
    }
  });

  test("a per-end-user rate limit refuses one identity WITHOUT reaching the upstream", async () => {
    // `monthlyQuota: null` on purpose — the quota gate runs first, and a
    // consumer that hit its monthly ceiling would refuse with the wrong message.
    const consumer = await ensureConsumer(FAIR, { monthlyQuota: null, endUserRateLimitPerMin: 1 });
    const session = await openKeyedSession("e2e-quota-fair-key", consumer.id);
    // Fresh identities per RUN. The bucket is a 60s FIXED window in the shared
    // `rate_counters` table keyed `enduser:<consumerId>:<identity>`, the
    // consumer id is stable across local re-runs, and a spent window cannot be
    // handed back inside the 30s test timeout — a hard-coded identity would
    // meet its own exhausted bucket and be refused on its FIRST call.
    const alice = `e2e-quota-alice-${Date.now()}`;
    const bob = `e2e-quota-bob-${Date.now()}`;
    try {
      const first = await callToolAsEndUser(session, alice);
      expect(first.status).toBe(200);
      expect(first.isError, `the first call for an identity was refused: ${first.text}`).toBeFalsy();
      expect(first.text).toContain("Ada Lovelace");

      const hitsBefore = await upstreamHits();
      const second = await callToolAsEndUser(session, alice);
      expect(second.status).toBe(200);
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(END_USER_REFUSAL);
      expect(await upstreamHits(), "a rate-limited end user must not reach the upstream").toBe(hitsBefore);

      // The bucket is per (consumer, identity): a second end user under the
      // SAME consumer and the SAME key is untouched. A regression that keyed it
      // on the consumer alone would take a whole tenant offline the moment one
      // of its users got busy — and would still pass a single-identity test.
      const other = await callToolAsEndUser(session, bob);
      expect(other.isError, `a different end user was refused: ${other.text}`).toBeFalsy();
      expect(other.text).toContain("Ada Lovelace");

      // And a call that asserts no identity at all is never limited: the check
      // is skipped outright rather than falling back to one shared bucket.
      const anonymous = await callTool(session);
      expect(anonymous.isError, `an unidentified call was refused: ${anonymous.text}`).toBeFalsy();
      const anonymousAgain = await callTool(session);
      expect(anonymousAgain.isError, "an unidentified caller must not be rate limited").toBeFalsy();
    } finally {
      await closeKeyedSession(session);
    }
  });

  test("the __end_user argument is honoured when no header is sent", async () => {
    // The documented fallback for a bare MCP client that can't set headers (see
    // the SECURITY NOTE on `resolveEndUserId`: it is a fairness knob, not an
    // authorization boundary, precisely because this signal is caller-asserted
    // and reaches the gate straight from the model's tool-call arguments).
    const consumer = await ensureConsumer(FAIR, { monthlyQuota: null, endUserRateLimitPerMin: 1 });
    const session = await openKeyedSession("e2e-quota-fair-arg-key", consumer.id);
    const carol = `e2e-quota-carol-${Date.now()}`;
    try {
      const first = await callTool(session, { __end_user: carol });
      expect(first.status).toBe(200);
      expect(first.isError, `the first call for an identity was refused: ${first.text}`).toBeFalsy();
      // The upstream answered normally even though `__end_user` isn't in the
      // tool's schema — Ajv is configured with `removeAdditional: "all"`, so an
      // unknown argument is stripped before the request is built rather than
      // rejected as a validation error.
      expect(first.text).toContain("Ada Lovelace");

      const hitsBefore = await upstreamHits();
      const second = await callTool(session, { __end_user: carol });
      expect(second.status).toBe(200);
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(END_USER_REFUSAL);
      expect(await upstreamHits(), "a rate-limited end user must not reach the upstream").toBe(hitsBefore);
    } finally {
      await closeKeyedSession(session);
    }
  });

  test("consumer writes require the admin role; reads do not", async ({ browser }) => {
    const subject = await ensureConsumer(RBAC, { monthlyQuota: RBAC_QUOTA, endUserRateLimitPerMin: null });
    await createAdminUser(request, auth, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      role: "operator",
    });

    // A fresh context so the operator session doesn't inherit the admin's
    // cookies from the shared `page`.
    const context = await browser.newContext();
    const operatorPage = await context.newPage();
    try {
      const operatorAuth = await loginAs(operatorPage, OPERATOR_USERNAME, OPERATOR_PASSWORD);
      const operator = operatorPage.context().request;

      const create = await operator.post(`${APP_BASE_URL}/admin-api/consumers`, {
        headers: apiHeaders(operatorAuth),
        data: { name: `${RBAC}-forbidden`, monthlyQuota: 1 },
      });
      expect(create.status()).toBe(403);
      const createErr = (await create.json()) as ApiErrorBody;
      expect(createErr.error.code).toBe("FORBIDDEN");
      // The literal message `requireAdminRole` emits — a regression that
      // downgraded these routes to `requireOperator` would 201 here instead.
      expect(createErr.error.message).toBe("This action requires the admin role");

      const patch = await operator.patch(`${APP_BASE_URL}/admin-api/consumers/${subject.id}`, {
        headers: apiHeaders(operatorAuth),
        data: { monthlyQuota: RBAC_QUOTA + 1 },
      });
      expect(patch.status()).toBe(403);
      expect(((await patch.json()) as ApiErrorBody).error.code).toBe("FORBIDDEN");

      const remove = await operator.delete(`${APP_BASE_URL}/admin-api/consumers/${subject.id}`, {
        headers: apiHeaders(operatorAuth),
      });
      expect(remove.status()).toBe(403);
      expect(((await remove.json()) as ApiErrorBody).error.code).toBe("FORBIDDEN");

      // Refused, not merely reported as refused — read back as the admin: the
      // row is still there and its quota is untouched. A 403 emitted after the
      // write would be worse than no gate at all, because it would hide it.
      const survivors = await listConsumers();
      expect(survivors.find((c) => c.id === subject.id)?.monthlyQuota).toBe(RBAC_QUOTA);
      expect(survivors.map((c) => c.name)).not.toContain(`${RBAC}-forbidden`);

      // Reads are NOT role-gated: `GET /consumers` and `GET /consumers/:id/usage`
      // carry only `adminAuth`, so every authenticated admin role — operator,
      // auditor, viewer — can read a consumer's quota config and its running
      // usage. Asserted because it IS the behaviour, not as an endorsement of it.
      const list = await operator.get(`${APP_BASE_URL}/admin-api/consumers`, { headers: apiHeaders(operatorAuth) });
      expect(list.status()).toBe(200);
      expect(((await list.json()) as { items: ConsumerListItem[] }).items.map((c) => c.name)).toContain(RBAC);

      const usage = await operator.get(`${APP_BASE_URL}/admin-api/consumers/${subject.id}/usage`, {
        headers: apiHeaders(operatorAuth),
      });
      expect(usage.status()).toBe(200);
      expect(((await usage.json()) as UsageView).quota).toBe(RBAC_QUOTA);
    } finally {
      await context.close();
    }
  });
});
