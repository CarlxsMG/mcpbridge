/**
 * End-to-end multi-tenancy isolation between two teams.
 *
 * What this proves that the unit/route tests don't: tenancy in this codebase is
 * NOT structural. There is no middleware that scopes a query by team — every
 * handler has to remember to thread `callerTeamId(req)` into its read model, or
 * to call `ensureClientAccess` before it mutates. A route that forgets looks
 * perfectly fine in isolation (its own unit test registers one client, calls the
 * handler, gets a row back), which is exactly how five consecutive audit rounds
 * each turned up another unscoped list endpoint or write-side ownership bypass.
 *
 * The only test that catches that class of bug is one where TWO tenants own
 * real, simultaneously-live resources in the same database and one of them goes
 * looking for the other's. So this spec builds that: Team Alpha and Team Beta,
 * an `admin`-role user inside each (a "team admin" — role admin WITH a team_id,
 * which is a different principal from the teamless bootstrap super-admin), and a
 * registered server owned by each, with tags/guards/monitors/usage/audit rows
 * attached to BOTH so every list endpoint below has a cross-tenant row available
 * to leak.
 *
 * Every negative assertion is paired with a positive control — Beta's own row
 * must come back from the same request that withheld Alpha's, and the teamless
 * super-admin must see both. Without those, a handler that simply returned
 * nothing (broken query, empty table, wrong path) would pass the "Alpha is
 * absent" half and prove nothing at all.
 *
 * Refusal contract, read from source rather than guessed (src/middleware/authz.ts):
 *   - `ensureClientAccess` answers a cross-tenant client with a 404
 *     CLIENT_NOT_FOUND — byte-identical to "no such client", so a scoped caller
 *     can't even probe for existence. NOT a 403.
 *   - `requireSuperAdmin` answers tenancy administration with a 403 FORBIDDEN.
 *   - The bulk client PATCH can't write a 404 mid-loop, so it uses
 *     `canCallerAccessClient` and reports the out-of-team name as `false`.
 *
 * Note on `catalog` and `alerts`, which the same audit round touched: neither
 * `catalog_entries` nor `alert_rules` has a `team_id` column (only `clients`,
 * `admin_users` and `consumers` do — migrations 26 and 38). They are global,
 * single-marketplace/platform-wide registries, so there is no "other tenant's
 * row" for a list read to leak; their isolation contract is instead that a
 * team-scoped admin cannot WRITE them. That's what this spec asserts for them,
 * in the super-admin-only table at the bottom.
 */
import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import {
  apiHeaders,
  createAdminUser,
  createTeam,
  loginAs,
  registerViaApi,
  setClientTeam,
  setUserTeam,
  type AdminAuth,
} from "./support/admin";

// ── Fixture identities (all `e2e-tenancy-*` so this spec coexists with the
// others in the one shared e2e database) ────────────────────────────────────
const ALPHA_TEAM = "e2e-tenancy-alpha";
const BETA_TEAM = "e2e-tenancy-beta";
const ALPHA_CLIENT = "e2e-tenancy-alpha-api";
const BETA_CLIENT = "e2e-tenancy-beta-api";
const ALPHA_ADMIN = "e2e-tenancy-alpha-admin";
const BETA_ADMIN = "e2e-tenancy-beta-admin";
/** >= 12 chars — the user-create rule in src/routes/admin/users.ts. */
const TEAM_ADMIN_PASSWORD = "e2e-tenancy-team-admin-pw-2026";
/** The tool discovered from fixtures/simple-openapi.json (served by global-setup.ts). */
const TOOL = "list-users";
/**
 * Deliberately the SAME tag on both teams' tools: `/tags/:tag/tools` then has a
 * cross-tenant row to leak on the very query a Beta admin would legitimately
 * run, which a per-team tag name would quietly hide.
 */
const SHARED_TAG = "e2e-tenancy";
/** Guard value written to both tools in setup — the baseline the policy test diffs against. */
const SETUP_TIMEOUT_MS = 5000;
const POLICY_NAME = "e2e-tenancy-policy";
/** Distinct from SETUP_TIMEOUT_MS so "did the policy land on this tool?" is unambiguous. */
const POLICY_TIMEOUT_MS = 7777;

// ── Response narrowing (TS strict: no `any`, no non-null assertions) ─────────

/** The `items` array of the `{ items: [...] }` envelope most admin lists return. */
function itemsOf(body: unknown): Record<string, unknown>[] {
  const items = typeof body === "object" && body !== null ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null);
}

/** Every string value of `key` across an `{ items: [...] }` envelope. */
function pluck(body: unknown, key: string): string[] {
  const out: string[] = [];
  for (const row of itemsOf(body)) {
    const value = row[key];
    if (typeof value === "string") out.push(value);
  }
  return out;
}

/** `code` out of the standard `{ error: { code, message, request_id } }` envelope. */
function errorCode(body: unknown): string | undefined {
  const err = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether a response row names this client. Two shapes occur across the swept
 * endpoints: a bare client name (`clients.name`, `usage.client`), and the
 * `clientName__toolName` composite the audit log stores as `target` — the same
 * two shapes `teamScopeCondition` in src/admin/audit/audit.ts recognizes.
 */
function referencesClient(ref: string, clientName: string): boolean {
  return ref === clientName || ref.startsWith(`${clientName}__`);
}

// ── Setup helpers (local to this spec, per the shared-helpers boundary) ──────

async function tagTool(request: APIRequestContext, auth: AdminAuth, client: string): Promise<void> {
  const res = await request.put(`${APP_BASE_URL}/admin-api/clients/${client}/tools/${TOOL}/tags`, {
    headers: apiHeaders(auth),
    data: { tags: [SHARED_TAG] },
  });
  expect(res.status(), `tag ${client}: ${await res.text()}`).toBe(200);
}

/** PATCHes a tool's guards — also the cheapest way to mint a `tool.guards.update` audit row. */
async function setToolTimeout(
  request: APIRequestContext,
  auth: AdminAuth,
  client: string,
  timeoutMs: number,
): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${client}/tools/${TOOL}`, {
    headers: apiHeaders(auth),
    data: { guards: { timeoutMs } },
  });
  expect(res.status(), `guards ${client}: ${await res.text()}`).toBe(200);
}

/** A monitor needs a saved example to replay, so create one and hand back its id. */
async function createExampleId(request: APIRequestContext, auth: AdminAuth, client: string): Promise<number> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/clients/${client}/tools/${TOOL}/examples`, {
    headers: apiHeaders(auth),
    data: { label: "e2e-tenancy-example", args: {} },
  });
  expect(res.status(), `example ${client}: ${await res.text()}`).toBe(201);
  const body: unknown = await res.json();
  const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "number") throw new Error(`example create returned no numeric id for ${client}`);
  return id;
}

/**
 * Creates the tool_monitor row `/admin-api/monitors` lists. `enabled: false`
 * deliberately — the row is all this spec needs, and an enabled monitor would
 * fire on the leader loop every interval and add unrelated proxy traffic.
 */
async function setMonitor(
  request: APIRequestContext,
  auth: AdminAuth,
  client: string,
  exampleId: number,
): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${client}/tools/${TOOL}`, {
    headers: apiHeaders(auth),
    data: { monitor: { exampleId, intervalMinutes: 1440, enabled: false } },
  });
  expect(res.status(), `monitor ${client}: ${await res.text()}`).toBe(200);
}

/**
 * Runs one synthetic call through the real proxy so `tool_call_log` has a row
 * for this client — that table is what every /usage endpoint reads.
 */
async function fireTestCall(request: APIRequestContext, auth: AdminAuth, client: string): Promise<void> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/clients/${client}/tools/${TOOL}/test`, {
    headers: apiHeaders(auth),
    data: {},
  });
  expect(res.status(), `test call ${client}: ${await res.text()}`).toBe(200);
}

/** Creates the guard policy, or finds it again on the 409 a local re-run produces. */
async function ensurePolicyId(request: APIRequestContext, auth: AdminAuth): Promise<number> {
  const created = await request.post(`${APP_BASE_URL}/admin-api/policies`, {
    headers: apiHeaders(auth),
    data: { name: POLICY_NAME, rateLimitPerMin: null, timeoutMs: POLICY_TIMEOUT_MS },
  });
  if (created.status() === 201) {
    const body: unknown = await created.json();
    const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== "number") throw new Error("policy create returned no numeric id");
    return id;
  }
  expect([409], `policy create failed: ${created.status()} ${await created.text()}`).toContain(created.status());

  const list = await request.get(`${APP_BASE_URL}/admin-api/policies`, { headers: apiHeaders(auth) });
  expect(list.status()).toBe(200);
  const body: unknown = await list.json();
  for (const row of itemsOf(body)) {
    if (row.name === POLICY_NAME && typeof row.id === "number") return row.id;
  }
  throw new Error(`policy ${POLICY_NAME} reported as existing but is not in the list`);
}

/** The tool's currently-persisted `guards.timeoutMs`, read back through GET /clients/:name. */
async function toolTimeoutMs(request: APIRequestContext, auth: AdminAuth, client: string): Promise<number | undefined> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/clients/${client}`, { headers: apiHeaders(auth) });
  expect(res.status(), `client detail ${client}: ${await res.text()}`).toBe(200);
  const body: unknown = await res.json();
  const tools = typeof body === "object" && body !== null ? (body as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return undefined;
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { name?: unknown; guards?: unknown };
    if (row.name !== TOOL) continue;
    const guards = row.guards;
    if (typeof guards !== "object" || guards === null) return undefined;
    const timeout = (guards as { timeoutMs?: unknown }).timeoutMs;
    return typeof timeout === "number" ? timeout : undefined;
  }
  return undefined;
}

// ── The tenancy-route matrix ────────────────────────────────────────────────

/**
 * List endpoints that join back to `clients.team_id` and must therefore filter
 * by the caller's team. Table-driven so covering a newly-added list endpoint is
 * a one-line change — mirroring the structural tenancy-route matrix the backend
 * suite already applies, but against the live HTTP surface.
 */
interface ScopedList {
  label: string;
  path: string;
  /** Client references carried by this endpoint's rows (see referencesClient). */
  refs: (body: unknown) => string[];
}

const SCOPED_LISTS: readonly ScopedList[] = [
  { label: "clients", path: "/admin-api/clients?limit=200", refs: (b) => pluck(b, "name") },
  {
    // Filtered to the action setup writes for both tenants, so the assertion
    // reads a bounded, deterministic set instead of racing the log's 200-row page.
    label: "audit-log",
    path: "/admin-api/audit-log?action=tool.guards.update&limit=200",
    refs: (b) => pluck(b, "target"),
  },
  { label: "usage/top-tools", path: "/admin-api/usage/top-tools?limit=100", refs: (b) => pluck(b, "client") },
  { label: "tags/:tag/tools", path: `/admin-api/tags/${SHARED_TAG}/tools`, refs: (b) => pluck(b, "client") },
  { label: "monitors", path: "/admin-api/monitors", refs: (b) => pluck(b, "clientName") },
];

async function listRefs(request: APIRequestContext, auth: AdminAuth, endpoint: ScopedList): Promise<string[]> {
  const res = await request.get(`${APP_BASE_URL}${endpoint.path}`, { headers: apiHeaders(auth) });
  expect(res.status(), `GET ${endpoint.path}: ${await res.text()}`).toBe(200);
  const body: unknown = await res.json();
  return endpoint.refs(body);
}

/**
 * Routes gated by `requireSuperAdmin` — tenancy administration, plus the two
 * global registries (catalog, alerts) that carry no team_id and are therefore
 * guarded on the write side instead of the read side.
 */
interface PrivilegedRoute {
  label: string;
  call: (request: APIRequestContext, auth: AdminAuth) => Promise<APIResponse>;
}

const SUPER_ADMIN_ONLY: readonly PrivilegedRoute[] = [
  {
    label: "POST /teams — stand up a new tenant",
    call: (r, a) =>
      r.post(`${APP_BASE_URL}/admin-api/teams`, { headers: apiHeaders(a), data: { name: "e2e-tenancy-escalation" } }),
  },
  {
    label: "GET /users — enumerate every tenant's accounts",
    call: (r, a) => r.get(`${APP_BASE_URL}/admin-api/users`, { headers: apiHeaders(a) }),
  },
  {
    // The escalation path users.ts documents: a teamless role:"admin" user IS a
    // super-admin, so minting one would be a self-promotion out of the tenant.
    label: "POST /users — mint a teamless super-admin",
    call: (r, a) =>
      r.post(`${APP_BASE_URL}/admin-api/users`, {
        headers: apiHeaders(a),
        data: { username: "e2e-tenancy-escalated", password: "e2e-tenancy-escalated-pw-2026", role: "admin" },
      }),
  },
  {
    label: "PUT /clients/:alpha/team — steal ownership of another tenant's server",
    call: (r, a) =>
      r.put(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}/team`, {
        headers: apiHeaders(a),
        data: { teamId: null },
      }),
  },
  {
    label: "PUT /users/:alphaAdmin/team — re-home another tenant's admin",
    call: (r, a) =>
      r.put(`${APP_BASE_URL}/admin-api/users/${ALPHA_ADMIN}/team`, { headers: apiHeaders(a), data: { teamId: null } }),
  },
  {
    label: "POST /catalog — plant an entry in the shared marketplace",
    call: (r, a) =>
      r.post(`${APP_BASE_URL}/admin-api/catalog`, {
        headers: apiHeaders(a),
        data: { slug: "e2e-tenancy-evil", name: "e2e tenancy evil", kind: "rest" },
      }),
  },
  {
    label: "POST /alerts — retarget platform-wide alerting at my own webhook",
    call: (r, a) =>
      r.post(`${APP_BASE_URL}/admin-api/alerts`, {
        headers: apiHeaders(a),
        data: { name: "e2e-tenancy-evil", eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/hook" },
      }),
  },
];

test.describe("multi-tenancy — Team Alpha and Team Beta are isolated", () => {
  let superContext: BrowserContext;
  let betaContext: BrowserContext;
  let superRequest: APIRequestContext;
  let betaRequest: APIRequestContext;
  let superAuth: AdminAuth;
  let betaAuth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    // Setup drives ~20 admin calls plus two real proxy round trips; the default
    // per-test timeout is sized for a single test, not for building the fixture.
    test.setTimeout(120_000);

    superContext = await browser.newContext();
    const superPage: Page = await superContext.newPage();
    superAuth = await loginAs(superPage);
    superRequest = superContext.request;

    // Two tenants, each with an `admin`-role user. NOTE: the bootstrap admin
    // must stay teamless — it is the last super-admin, and setUserTeam refuses
    // to strand it (LAST_SUPERADMIN_PROTECTED).
    const alphaTeamId = await createTeam(superRequest, superAuth, ALPHA_TEAM);
    const betaTeamId = await createTeam(superRequest, superAuth, BETA_TEAM);
    await createAdminUser(superRequest, superAuth, {
      username: ALPHA_ADMIN,
      password: TEAM_ADMIN_PASSWORD,
      role: "admin",
    });
    await createAdminUser(superRequest, superAuth, {
      username: BETA_ADMIN,
      password: TEAM_ADMIN_PASSWORD,
      role: "admin",
    });
    await setUserTeam(superRequest, superAuth, ALPHA_ADMIN, alphaTeamId);
    await setUserTeam(superRequest, superAuth, BETA_ADMIN, betaTeamId);

    // One registered server per tenant. Registration leaves team_id null, so
    // ownership is assigned immediately after.
    await registerViaApi(superRequest, superAuth, ALPHA_CLIENT);
    await registerViaApi(superRequest, superAuth, BETA_CLIENT);
    await setClientTeam(superRequest, superAuth, ALPHA_CLIENT, alphaTeamId);
    await setClientTeam(superRequest, superAuth, BETA_CLIENT, betaTeamId);

    // Give every swept endpoint a row on BOTH sides of the tenancy boundary —
    // otherwise "Beta can't see Alpha's row" would be vacuously true.
    for (const client of [ALPHA_CLIENT, BETA_CLIENT]) {
      await tagTool(superRequest, superAuth, client); // -> /tags/:tag/tools
      await setMonitor(superRequest, superAuth, client, await createExampleId(superRequest, superAuth, client)); // -> /monitors
      await fireTestCall(superRequest, superAuth, client); // -> /usage/*
      // Last write wins, and the policy test below diffs against this value.
      await setToolTimeout(superRequest, superAuth, client, SETUP_TIMEOUT_MS); // -> /audit-log
    }

    // A separate context so the Beta session never inherits the super-admin's cookies.
    betaContext = await browser.newContext();
    const betaPage: Page = await betaContext.newPage();
    betaAuth = await loginAs(betaPage, BETA_ADMIN, TEAM_ADMIN_PASSWORD);
    betaRequest = betaContext.request;
  });

  test.afterAll(async () => {
    await superContext.close();
    await betaContext.close();
  });

  // ── (1)+(2)+(3) The owned resource itself ─────────────────────────────────

  test("Beta's admin reads its OWN server (positive control for the 404s below)", async () => {
    const res = await betaRequest.get(`${APP_BASE_URL}/admin-api/clients/${BETA_CLIENT}`, {
      headers: apiHeaders(betaAuth),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body: unknown = await res.json();
    const name = typeof body === "object" && body !== null ? (body as { name?: unknown }).name : undefined;
    expect(name).toBe(BETA_CLIENT);
  });

  test("reading Alpha's server by name is refused as 404 CLIENT_NOT_FOUND (existence is hidden, not just access)", async () => {
    const res = await betaRequest.get(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}`, {
      headers: apiHeaders(betaAuth),
    });
    // 404, not 403: ensureClientAccess deliberately answers with the identical
    // envelope an unregistered name gets, so this response can't be used to
    // enumerate other tenants' server names.
    expect(res.status(), await res.text()).toBe(404);
    expect(errorCode(await res.json())).toBe("CLIENT_NOT_FOUND");
  });

  test("PATCHing a guard on Alpha's tool is refused and leaves Alpha's guard untouched", async () => {
    const res = await betaRequest.patch(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}/tools/${TOOL}`, {
      headers: apiHeaders(betaAuth),
      data: { guards: { timeoutMs: 1 } },
    });
    expect(res.status(), await res.text()).toBe(404);
    expect(errorCode(await res.json())).toBe("CLIENT_NOT_FOUND");
    // The refusal has to be a real refusal, not a 404 written after the write
    // already landed — verify through the super-admin, who can actually see it.
    expect(await toolTimeoutMs(superRequest, superAuth, ALPHA_CLIENT)).toBe(SETUP_TIMEOUT_MS);
  });

  test("running Alpha's tool through the admin test-call endpoint is refused", async () => {
    // The tenancy hole that matters most: not reading config, but executing
    // another tenant's tool against their backend through the live proxy.
    const res = await betaRequest.post(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}/tools/${TOOL}/test`, {
      headers: apiHeaders(betaAuth),
      data: {},
    });
    expect(res.status(), await res.text()).toBe(404);
    expect(errorCode(await res.json())).toBe("CLIENT_NOT_FOUND");
  });

  test("deleting Alpha's server is refused and the server survives", async () => {
    const res = await betaRequest.delete(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}`, {
      headers: apiHeaders(betaAuth),
    });
    expect(res.status(), await res.text()).toBe(404);
    expect(errorCode(await res.json())).toBe("CLIENT_NOT_FOUND");

    const stillThere = await superRequest.get(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}`, {
      headers: apiHeaders(superAuth),
    });
    expect(stillThere.status(), "Alpha's server was actually deleted by a refused request").toBe(200);
  });

  test("the BULK client PATCH reports Alpha as not-found instead of toggling it", async () => {
    // Distinct code path: a bulk loop can't write a 404 mid-iteration, so it
    // uses canCallerAccessClient and folds the refusal into the per-name result.
    const res = await betaRequest.patch(`${APP_BASE_URL}/admin-api/clients`, {
      headers: apiHeaders(betaAuth),
      data: { names: [ALPHA_CLIENT, BETA_CLIENT], enabled: false },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body: unknown = await res.json();

    // Re-enable Beta's own server BEFORE asserting: the request above really
    // does disable it (that's the positive control), and an assertion failure
    // between here and the end of the test would otherwise strand it disabled
    // for every later test and for a local re-run against the same database.
    const restore = await betaRequest.patch(`${APP_BASE_URL}/admin-api/clients`, {
      headers: apiHeaders(betaAuth),
      data: { names: [BETA_CLIENT], enabled: true },
    });
    expect(restore.status()).toBe(200);

    const results = typeof body === "object" && body !== null ? (body as { results?: unknown }).results : undefined;
    expect(typeof results === "object" && results !== null).toBe(true);
    const map = results as Record<string, unknown>;
    expect(map[ALPHA_CLIENT], "Alpha was toggled by another tenant's bulk PATCH").toBe(false);
    // Positive control: Beta's own name in the same request DID take effect.
    expect(map[BETA_CLIENT]).toBe(true);

    const alpha = await superRequest.get(`${APP_BASE_URL}/admin-api/clients/${ALPHA_CLIENT}`, {
      headers: apiHeaders(superAuth),
    });
    expect(alpha.status()).toBe(200);
    const alphaBody: unknown = await alpha.json();
    const enabled =
      typeof alphaBody === "object" && alphaBody !== null ? (alphaBody as { enabled?: unknown }).enabled : undefined;
    expect(enabled, "Alpha's server was disabled by another tenant").toBe(true);
  });

  // ── (4) The list endpoints that historically leaked ───────────────────────

  for (const endpoint of SCOPED_LISTS) {
    test(`GET ${endpoint.label} — Beta's admin sees Beta's rows and none of Alpha's`, async () => {
      const refs = await listRefs(betaRequest, betaAuth, endpoint);
      const leaked = refs.filter((r) => referencesClient(r, ALPHA_CLIENT));
      expect(leaked, `${endpoint.label} leaked Team Alpha's rows to Team Beta`).toEqual([]);
      // Positive control — the absence above is scoping, not an empty response.
      expect(
        refs.some((r) => referencesClient(r, BETA_CLIENT)),
        `${endpoint.label} returned none of Beta's OWN rows (got: ${refs.join(", ") || "<empty>"}), so the check above proves nothing`,
      ).toBe(true);
    });
  }

  test("GET /usage/summary?client= — Alpha's name is refused, Beta's own is served", async () => {
    // The aggregate views filter by team; an explicit ?client= is the probe a
    // scoped caller would reach for instead, so it goes through ensureClientAccess.
    const cross = await betaRequest.get(`${APP_BASE_URL}/admin-api/usage/summary?client=${ALPHA_CLIENT}`, {
      headers: apiHeaders(betaAuth),
    });
    expect(cross.status(), await cross.text()).toBe(404);
    expect(errorCode(await cross.json())).toBe("CLIENT_NOT_FOUND");

    const own = await betaRequest.get(`${APP_BASE_URL}/admin-api/usage/summary?client=${BETA_CLIENT}`, {
      headers: apiHeaders(betaAuth),
    });
    expect(own.status(), await own.text()).toBe(200);
    const body: unknown = await own.json();
    const calls = typeof body === "object" && body !== null ? (body as { calls?: unknown }).calls : undefined;
    expect(typeof calls === "number" && calls >= 1, `expected Beta's own usage rows, got calls=${String(calls)}`).toBe(
      true,
    );
  });

  // ── (5) The filtering is tenancy-scoping, not a blanket denial ────────────

  for (const endpoint of SCOPED_LISTS) {
    test(`GET ${endpoint.label} — the teamless super-admin sees BOTH teams' rows`, async () => {
      const refs = await listRefs(superRequest, superAuth, endpoint);
      expect(
        refs.some((r) => referencesClient(r, ALPHA_CLIENT)),
        `${endpoint.label} withheld Alpha's rows from a super-admin — that's a broken query, not scoping`,
      ).toBe(true);
      expect(refs.some((r) => referencesClient(r, BETA_CLIENT))).toBe(true);
    });
  }

  // ── Tenancy administration + the global registries ───────────────────────

  for (const route of SUPER_ADMIN_ONLY) {
    test(`${route.label} — refused for a team-scoped admin (403 FORBIDDEN)`, async () => {
      const res = await route.call(betaRequest, betaAuth);
      // 403 here, not the 404 the client routes use: requireSuperAdmin guards a
      // capability rather than a specific tenant's resource, so there is no
      // existence to hide.
      expect(res.status(), await res.text()).toBe(403);
      expect(errorCode(await res.json())).toBe("FORBIDDEN");
    });
  }

  // ── Guard-policy apply: the cross-tenant overwrite that shipped once ──────

  test("applying a guard policy to Alpha's tool skips it and overwrites nothing", async () => {
    // Guard policies are global (no team_id), and any admin may create one — so
    // the tenancy boundary has to be enforced at APPLY time, per-tool ref. A
    // regression here silently rewrites another tenant's rate limits/timeouts.
    const policyId = await ensurePolicyId(betaRequest, betaAuth);

    const res = await betaRequest.post(`${APP_BASE_URL}/admin-api/policies/${policyId}/apply`, {
      headers: apiHeaders(betaAuth),
      data: {
        tools: [
          { client: ALPHA_CLIENT, tool: TOOL },
          { client: BETA_CLIENT, tool: TOOL },
        ],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body: unknown = await res.json();
    const applied = typeof body === "object" && body !== null ? (body as { applied?: unknown }).applied : undefined;
    // Exactly one of the two refs was the caller's own.
    expect(applied, "the policy applied to more tools than the caller owns").toBe(1);

    // And the guards themselves: Beta's moved (proving the read-back below can
    // actually observe a policy landing), Alpha's did not.
    expect(await toolTimeoutMs(betaRequest, betaAuth, BETA_CLIENT)).toBe(POLICY_TIMEOUT_MS);
    expect(
      await toolTimeoutMs(superRequest, superAuth, ALPHA_CLIENT),
      "a team-scoped admin overwrote another tenant's tool guards through policy apply",
    ).toBe(SETUP_TIMEOUT_MS);
  });
});
