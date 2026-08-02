/**
 * End-to-end test for the admin audit trail — the record of who changed what.
 *
 * The backend unit tests around `recordAudit()` prove a row gets written and
 * that `verifyAuditChain()` detects a doctored one. What they can't see is
 * whether the row describes what actually happened when a real, logged-in
 * operator drives a real mutation: this spec creates a dedicated account, makes
 * three distinct changes AS that account, and then asserts the log attributes
 * them to that username with the real action strings and targets. A regression
 * that stamped every row with a generic "admin" — or with whoever happened to
 * set the fixtures up — writes a perfectly valid row and passes every unit
 * test, while destroying the only thing an audit log is for.
 *
 * It also pins the surrounding contract: the log is append-only from the API
 * (src/routes/admin/audit-log.ts registers four GETs and no mutating route at
 * all), the hash chain still verifies after new entries are appended, reading
 * the log is operator-gated (auditor and viewer are both refused, despite the
 * name), the SPA renders the entries, and the cursor pager walks backwards
 * without re-serving page one.
 *
 * Two deliberate constraints on how this spec gets the backend into shape:
 *
 *   - It never mints a managed MCP key. The first key to exist flips the data
 *     plane out of "open mode" process-wide, and auth-fail-closed.spec.ts
 *     asserts on exactly that transition — this file sorts BEFORE it, so a key
 *     minted here would break that spec rather than this one.
 *   - It registers its client via POST /register, which writes NO audit record
 *     (there is no `recordAudit` call in src/routes/register.ts). Registration
 *     is therefore setup, not one of the mutations under test.
 *
 * Every assertion filters on this spec's own actor/target names. Earlier specs
 * share the database and the audit log grows across the whole run, so absolute
 * row counts and "the newest entry is mine" are never asserted.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_USERNAME } from "./support/env";
import { apiHeaders, createAdminUser, loginAs, registerViaApi, type AdminAuth } from "./support/admin";

/** Unique per-spec entity names — everything below filters on these. */
const SERVER_NAME = "e2e-audit-api";
/** The tool discovered from fixtures/simple-openapi.json (served by global-setup.ts). */
const TOOL_NAME = "list-users";
/** The canonical `client__tool` key the tool-mutation dispatcher stamps as the audit target. */
const TOOL_TARGET = `${SERVER_NAME}__${TOOL_NAME}`;

/** The dedicated account whose username must appear as the `actor` on everything it does. */
const ACTOR_USERNAME = "e2e-audit-actor";
const ACTOR_PASSWORD = "e2e-audit-actor-pw-2026"; // >= 12 chars (user-create rule)

/**
 * The two accounts below the operator tier. Both must be refused a read of the
 * log — "auditor" especially: the name suggests audit access, but
 * `requireOperator` (src/middleware/authz.ts) puts auditor on the same floor as
 * viewer, and src/routes/admin/audit-log.ts gates list/verify/export on it.
 */
const LOWER_PRIVILEGE_ACCOUNTS = [
  { username: "e2e-audit-viewer", password: "e2e-audit-viewer-pw-2026", role: "viewer" },
  { username: "e2e-audit-auditor", password: "e2e-audit-auditor-pw-2026", role: "auditor" },
] as const;

/** One row as GET /admin-api/audit-log returns it (AuditLogEntry in src/admin/audit/audit.ts). */
interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
  /** Chain hash of this row; null only for rows predating the hash-chain migration. */
  hash: string | null;
}

/** The list envelope: keyset-paginated, newest id first, `nextCursor` only when another page exists. */
interface AuditPage {
  items: AuditEntry[];
  nextCursor?: string;
}

/** GET /admin-api/audit-log/verify — the verdict of a full chain walk from the genesis row. */
interface ChainStatus {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
}

/** Read the audit log as `auth` with the given query filters. Fails loudly on a non-200. */
async function readAuditLog(
  request: APIRequestContext,
  auth: AdminAuth,
  query: Record<string, string> = {},
): Promise<AuditPage> {
  const qs = new URLSearchParams(query).toString();
  const res = await request.get(`${APP_BASE_URL}/admin-api/audit-log?${qs}`, { headers: apiHeaders(auth) });
  expect(res.status(), `audit-log read failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as AuditPage;
}

/**
 * The newest entry written by `actor` for `action`. Throws rather than
 * returning undefined so callers can read the row's fields without a non-null
 * assertion, and so a missing record fails naming the pair that was expected.
 */
async function requireEntry(
  request: APIRequestContext,
  auth: AdminAuth,
  actor: string,
  action: string,
): Promise<AuditEntry> {
  const page = await readAuditLog(request, auth, { actor, action, limit: "1" });
  const entry = page.items[0];
  if (!entry) throw new Error(`no audit entry for actor=${actor} action=${action}`);
  return entry;
}

/** Ask the backend to walk the hash chain and report the first inconsistency, if any. */
async function verifyChain(request: APIRequestContext, auth: AdminAuth): Promise<ChainStatus> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/audit-log/verify`, { headers: apiHeaders(auth) });
  expect(res.status(), `chain verify failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as ChainStatus;
}

/** Toggle the client's enabled flag — the `client.enable` / `client.disable` audit actions. */
async function setClientEnabled(request: APIRequestContext, auth: AdminAuth, enabled: boolean): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER_NAME}`, {
    headers: apiHeaders(auth),
    data: { enabled },
  });
  expect(res.status(), `client enabled=${enabled} failed: ${await res.text()}`).toBe(200);
}

/** Set the tool's rate-limit guard — the `tool.guards.update` audit action. */
async function setToolGuard(request: APIRequestContext, auth: AdminAuth, rateLimitPerMin: number): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER_NAME}/tools/${TOOL_NAME}`, {
    headers: apiHeaders(auth),
    data: { guards: { rateLimitPerMin } },
  });
  expect(res.status(), `tool guard patch failed: ${await res.text()}`).toBe(200);
}

test.describe("Audit trail — attribution, append-only storage, hash chain and access control", () => {
  let adminContext: BrowserContext;
  let adminPage: Page;
  let adminRequest: APIRequestContext;
  let adminAuth: AdminAuth;

  let actorContext: BrowserContext;
  let actorRequest: APIRequestContext;
  let actorAuth: AdminAuth;

  /** Chain length before this spec appends anything — the baseline for the growth assertion. */
  let chainBefore: ChainStatus;

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    adminAuth = await loginAs(adminPage);
    adminRequest = adminContext.request;

    // Setup, by the bootstrap admin: a client to act on, plus the accounts the
    // attribution and RBAC assertions need. Tolerates the 409s a re-run against
    // a reused dev server produces (playwright.config.ts reuseExistingServer).
    await registerViaApi(adminRequest, adminAuth, SERVER_NAME);
    await createAdminUser(adminRequest, adminAuth, {
      username: ACTOR_USERNAME,
      password: ACTOR_PASSWORD,
      role: "operator",
    });
    for (const account of LOWER_PRIVILEGE_ACCOUNTS) {
      await createAdminUser(adminRequest, adminAuth, account);
    }

    chainBefore = await verifyChain(adminRequest, adminAuth);

    // Everything below is done BY the dedicated operator, from its own browser
    // context, so the actor recorded on each row can only have come from that
    // session — not from the bootstrap admin who did the setup above.
    actorContext = await browser.newContext();
    const actorPage = await actorContext.newPage();
    actorAuth = await loginAs(actorPage, ACTOR_USERNAME, ACTOR_PASSWORD);
    actorRequest = actorContext.request;

    await setClientEnabled(actorRequest, actorAuth, false);
    await setClientEnabled(actorRequest, actorAuth, true);
    await setToolGuard(actorRequest, actorAuth, 77);
  });

  test.afterAll(async () => {
    await adminContext.close();
    await actorContext.close();
  });

  test("each mutation is recorded with the acting user, the real action string and the target", async () => {
    // Client-level toggles are audited in src/routes/admin/clients.ts with the
    // client name as the target.
    const disabled = await requireEntry(adminRequest, adminAuth, ACTOR_USERNAME, "client.disable");
    expect(disabled.actor).toBe(ACTOR_USERNAME);
    expect(disabled.target).toBe(SERVER_NAME);

    const enabled = await requireEntry(adminRequest, adminAuth, ACTOR_USERNAME, "client.enable");
    expect(enabled.actor).toBe(ACTOR_USERNAME);
    expect(enabled.target).toBe(SERVER_NAME);

    // The per-tool guard PATCH is audited by the mutation dispatcher
    // (src/admin/tool-policies/mutations/index.ts), which stamps the canonical
    // `client__tool` key as the target — not the bare tool name.
    const guards = await requireEntry(adminRequest, adminAuth, ACTOR_USERNAME, "tool.guards.update");
    expect(guards.actor).toBe(ACTOR_USERNAME);
    expect(guards.target).toBe(TOOL_TARGET);

    // Three distinct rows, not one row read three times.
    expect(new Set([disabled.id, enabled.id, guards.id]).size).toBe(3);
  });

  test("the actor is the user who acted, not a generic admin", async () => {
    // Everything filed under this spec's actor really is that user's work…
    const mine = await readAuditLog(adminRequest, adminAuth, { actor: ACTOR_USERNAME, limit: "200" });
    expect(mine.items.length).toBeGreaterThanOrEqual(3);
    expect(mine.items.every((e) => e.actor === ACTOR_USERNAME)).toBe(true);

    // …and the guard PATCH the operator made was NOT attributed to the
    // bootstrap admin who registered the client and created the account. This
    // is the regression a unit test asserting only "a row was written" misses.
    const asBootstrap = await readAuditLog(adminRequest, adminAuth, {
      actor: BOOTSTRAP_ADMIN_USERNAME,
      action: "tool.guards.update",
      limit: "200",
    });
    expect(asBootstrap.items.some((e) => e.target === TOOL_TARGET)).toBe(false);

    // Positive control from the other side: the account creation the bootstrap
    // admin DID perform is attributed to the bootstrap admin. So the log
    // genuinely distinguishes two identities rather than labelling everything
    // with one of them.
    const creations = await readAuditLog(adminRequest, adminAuth, {
      actor: BOOTSTRAP_ADMIN_USERNAME,
      action: "user.create",
      limit: "200",
    });
    expect(creations.items.some((e) => e.target === ACTOR_USERNAME)).toBe(true);
  });

  test("the log is append-only from the API — no route edits, deletes or forges an entry", async () => {
    const entry = await requireEntry(adminRequest, adminAuth, ACTOR_USERNAME, "tool.guards.update");
    const url = `${APP_BASE_URL}/admin-api/audit-log/${entry.id}`;
    const headers = apiHeaders(adminAuth);

    // What is pinned here is the ABSENCE of a route: src/routes/admin/audit-log
    // .ts registers four GETs (list / verify / actions / export) and nothing
    // else, and rows are only ever written in-band by recordAudit() from the
    // handler that caused them. These calls carry a super-admin session AND a
    // valid X-CSRF-Token, so a 404 means "that route does not exist" rather
    // than "auth rejected it" — no top-level `/:param` route under /admin-api
    // can swallow these paths either.
    const attempts = [
      await adminRequest.delete(url, { headers }),
      await adminRequest.patch(url, { headers, data: { action: "tampered" } }),
      await adminRequest.put(url, { headers, data: { action: "tampered" } }),
      await adminRequest.post(`${APP_BASE_URL}/admin-api/audit-log`, { headers, data: { action: "forged" } }),
      await adminRequest.delete(`${APP_BASE_URL}/admin-api/audit-log`, { headers }),
    ];
    for (const res of attempts) {
      expect(res.status(), `${res.url()} unexpectedly routed to a handler`).toBe(404);
    }

    // And the row is untouched afterwards — same id, same content hash.
    const after = await requireEntry(adminRequest, adminAuth, ACTOR_USERNAME, "tool.guards.update");
    expect(after.id).toBe(entry.id);
    expect(after.hash).toBe(entry.hash);
    expect(after.target).toBe(TOOL_TARGET);
  });

  test("the hash chain still verifies clean after the new entries were appended", async () => {
    expect(chainBefore.ok).toBe(true);

    const after = await verifyChain(adminRequest, adminAuth);
    expect(after.ok).toBe(true);
    expect(after.brokenAtId).toBeUndefined();
    // recordAudit() chains every insert onto the previous row's hash inside one
    // IMMEDIATE transaction, so the walk must now cover at least the three rows
    // this spec appended (>= because other specs and the schedule loop share
    // this log).
    expect(after.checked).toBeGreaterThanOrEqual(chainBefore.checked + 3);

    // The list API exposes each row's own hash but not its prev_hash, so the
    // LINKAGE is what /verify proves — it recomputes every row from the genesis
    // row and reports the first mismatch. What the list envelope can show is
    // that the rows are chained at all: a 64-hex digest each, and no two rows
    // sharing one (the injectivity the JSON-tuple pre-image exists to give).
    const mine = await readAuditLog(adminRequest, adminAuth, { actor: ACTOR_USERNAME, limit: "200" });
    const hashes = mine.items.map((e) => e.hash);
    expect(hashes.length).toBeGreaterThanOrEqual(3);
    expect(hashes.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("reading the log is operator-gated — a viewer and an auditor are both refused", async ({ browser }) => {
    for (const account of LOWER_PRIVILEGE_ACCOUNTS) {
      // A fresh, isolated context per account so neither inherits the admin's
      // cookies from the shared context above.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const auth = await loginAs(page, account.username, account.password);
        const headers = apiHeaders(auth);

        const list = await context.request.get(`${APP_BASE_URL}/admin-api/audit-log`, { headers });
        expect(list.status(), `${account.role} was allowed to read the audit log`).toBe(403);
        const body = (await list.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("FORBIDDEN");

        // The chain-verify and bulk-export reads sit behind the same gate — a
        // row's detail_json can carry the same payload data the traffic reads
        // were raised to operator+ to protect.
        const verify = await context.request.get(`${APP_BASE_URL}/admin-api/audit-log/verify`, { headers });
        expect(verify.status(), `${account.role} was allowed to verify the chain`).toBe(403);
        const exported = await context.request.get(`${APP_BASE_URL}/admin-api/audit-log/export`, { headers });
        expect(exported.status(), `${account.role} was allowed to export the log`).toBe(403);

        // The distinct-actions list is a projection of the very rows above, so
        // it belongs behind the same gate. It shipped without one — the only
        // route in the file that missed it — which let a viewer or auditor
        // enumerate which action types a deployment had performed while being
        // refused the entries themselves.
        const actions = await context.request.get(`${APP_BASE_URL}/admin-api/audit-log/actions`, { headers });
        expect(actions.status(), `${account.role} was allowed to enumerate audit actions`).toBe(403);
      } finally {
        await context.close();
      }
    }

    // Positive control: the operator tier IS enough, so the 403s above are the
    // role gate and not a broken endpoint.
    const allowed = await readAuditLog(actorRequest, actorAuth, { actor: ACTOR_USERNAME, limit: "1" });
    expect(allowed.items.length).toBe(1);

    const allowedActions = await actorRequest.get(`${APP_BASE_URL}/admin-api/audit-log/actions`, {
      headers: apiHeaders(actorAuth),
    });
    expect(allowedActions.status(), "an operator must still be able to populate the action filter").toBe(200);
    const actionsBody = (await allowedActions.json()) as { actions?: string[] };
    // The admin-ui action filter is driven by this list, so an empty response
    // would silently degrade the page rather than fail it — assert it really
    // carries the actions this spec's own mutations produced.
    expect(actionsBody.actions).toContain("tool.guards.update");
  });

  test("the SPA's audit-log page renders the entry and verifies the chain from the UI", async () => {
    await adminPage.goto("/admin/audit-log");
    await expect(adminPage.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();

    // Filter to this spec's actor through the real form. The action filter is a
    // custom SelectMenu, so the plain-input actor filter is what this drives —
    // it exercises the same apply-on-submit path without depending on that
    // component's click behaviour.
    await adminPage.locator("#actor-filter").fill(ACTOR_USERNAME);
    const [filtered] = await Promise.all([
      adminPage.waitForResponse(
        (r) => r.url().includes("/admin-api/audit-log?") && r.url().includes(`actor=${ACTOR_USERNAME}`),
      ),
      adminPage.getByRole("button", { name: "Apply", exact: true }).click(),
    ]);
    expect(filtered.status(), `filtered audit-log fetch failed: ${await filtered.text()}`).toBe(200);

    // The row for the guard PATCH must show all three of actor, action and
    // target — this is the part no unit test reaches, since it goes DB -> admin
    // API -> cursor-paginated store -> rendered table.
    const row = adminPage.locator("table.data-table tbody tr").filter({ hasText: TOOL_TARGET }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(ACTOR_USERNAME);
    await expect(row).toContainText("tool.guards.update");

    // The integrity check an operator actually clicks, not just the endpoint.
    await adminPage.getByRole("button", { name: "Verify integrity" }).click();
    await expect(adminPage.locator("p.integrity.ok")).toContainText("Chain intact");
  });

  test("cursor pagination walks back through the entries and page one stays stable", async () => {
    const first = await readAuditLog(adminRequest, adminAuth, { actor: ACTOR_USERNAME, limit: "2" });
    expect(first.items.length).toBe(2);
    // listAuditLog orders by id DESC and fetches limit+1 to decide `nextCursor`
    // without a COUNT, so the cursor is the last returned row's id, replayed by
    // the next request as `id < ?`.
    expect(first.nextCursor).toBe(String(first.items[1].id));

    const cursor = first.nextCursor;
    if (!cursor) throw new Error("expected a nextCursor — this spec's actor has more than two entries");

    const second = await readAuditLog(adminRequest, adminAuth, { actor: ACTOR_USERNAME, limit: "2", cursor });
    expect(second.items.length).toBeGreaterThan(0);

    const firstIds = first.items.map((e) => e.id);
    const secondIds = second.items.map((e) => e.id);
    // Page two is strictly older and shares nothing with page one — a pager
    // that silently drops its cursor re-serves page one instead.
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(Math.max(...secondIds)).toBeLessThan(Math.min(...firstIds));

    // Going back to the cursor-less first page returns exactly the original rows.
    const back = await readAuditLog(adminRequest, adminAuth, { actor: ACTOR_USERNAME, limit: "2" });
    expect(back.items.map((e) => e.id)).toEqual(firstIds);
  });
});
