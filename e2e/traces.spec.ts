/**
 * End-to-end test for the built-in trace viewer — the per-call span record
 * behind `/admin-api/traces` and the SPA's Traces page.
 *
 * ── THIS SPEC DEPENDS ON A BOOT FLAG ────────────────────────────────────────
 * Spans are only persisted when tracing is switched on at BOOT:
 * `tracingEnabled()` (src/observability/tracing.ts) is
 * `Boolean(config.otelEndpoint) || config.traceStorageEnabled`, and
 * `config.traceStorageEnabled` (src/config.ts) is read once, at module load,
 * from `process.env.TRACE_STORAGE === "true"`. There is no admin API or
 * runtime toggle for it, so a locally reused server (`reuseExistingServer`)
 * has to be killed for a change to take effect. playwright.config.ts's
 * `webServer.env` sets it — if that line is ever removed, `beforeAll` fails
 * with a message naming the variable rather than the whole file collapsing
 * into unexplained assertion errors.
 *
 * That check is an ASSERTION, not a skip guard, and the distinction is the
 * point: an earlier draft skipped every span-dependent test whenever the probe
 * came back empty, which made a broken span writer indistinguishable from a
 * switched-off one — neutering `persistSpan`'s call site turned the file into
 * a green run with seven skips instead of seven failures.
 *
 * Two deliberate choices about the shared database:
 *
 *   - `beforeAll` PURGES all spans before generating its own traffic. The
 *     suite shares one backend, so with tracing on every earlier spec's tool
 *     calls would be in the table too and the exact counts below ("this
 *     session made 2 calls", "top-sessions says 2") would be hostage to
 *     whatever ran first. Nothing else in the suite reads traces, so the
 *     purge costs no other spec anything.
 *   - The purge tests run LAST for the same reason, and the final one leaves
 *     the table empty on purpose — a re-run against a reused dev server
 *     (playwright.config.ts `reuseExistingServer`) therefore starts clean.
 *
 * The success/failure pair is ordered success-then-failure on purpose: the e2e
 * env sets `CIRCUIT_BREAKER_FAILURE_THRESHOLD=2`, so a leading success keeps
 * the client's consecutive-failure count at 1 and the breaker closed — a
 * breaker that opened would refuse at the gate and change what the failing
 * call's trace actually describes.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_USERNAME } from "./support/env";
import {
  apiHeaders,
  createAdminUser,
  createTeam,
  loginAs,
  mintMcpKey,
  registerViaApi,
  setClientTeam,
  setUserTeam,
  type AdminAuth,
} from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall } from "./support/mcp";

// ── Fixtures under test ─────────────────────────────────────────────────────

/** The traced backend. Teamless, so it is the "other tenant" for the team-scoped read. */
const TRACED_CLIENT = "e2e-trace-api";
/** A second backend, owned by a team — the positive control for the tenancy scope. */
const TEAM_CLIENT = "e2e-trace-team-api";

/** Tools discovered from fixtures/simple-openapi.json (served by global-setup.ts). */
const SUCCESS_TOOL = "list-users";
/** POST /api/v1/users is deliberately unhandled by the fixture (404) — the failing call. */
const FAILURE_TOOL = "create-user";

/** The canonical `clientName__toolName` keys — what `mcp_tool_name` stores and `?tool=` matches. */
const SUCCESS_TOOL_KEY = `${TRACED_CLIENT}__${SUCCESS_TOOL}`;
const FAILURE_TOOL_KEY = `${TRACED_CLIENT}__${FAILURE_TOOL}`;
const TEAM_TOOL_KEY = `${TEAM_CLIENT}__${SUCCESS_TOOL}`;

/** Tenancy fixtures — a team, its admin (role admin WITH a team_id) and its client. */
const TEAM_NAME = "e2e-trace-team";
const TEAM_ADMIN_USERNAME = "e2e-trace-team-admin";
const TEAM_ADMIN_PASSWORD = "e2e-trace-team-admin-pw-2026"; // >= 12 chars (user-create rule)

/**
 * The two accounts below the admin tier. Both must be refused the purge
 * (`requireAdminRole`, src/middleware/authz.ts) while still being allowed to
 * READ: src/routes/traces.ts gates the whole router on `adminAuth` only and
 * adds `requireAdminRole` to the DELETE alone, so the read tier really is
 * "any authenticated admin-API caller".
 */
const LOWER_PRIVILEGE_ACCOUNTS = [
  { username: "e2e-trace-operator", password: "e2e-trace-operator-pw-2026", role: "operator" },
  { username: "e2e-trace-viewer", password: "e2e-trace-viewer-pw-2026", role: "viewer" },
] as const;

/** A trace id that cannot exist — 32 lowercase hex is the minted shape (newTraceId). */
const UNKNOWN_TRACE_ID = "00000000000000000000000000000e2e";

// ── Response shapes (read off src/observability/trace-store.ts) ──────────────

/** One row of GET /admin-api/traces — one trace, aggregated from its spans. */
interface TraceSummary {
  traceId: string;
  spanCount: number;
  startMs: number;
  endMs: number;
  mcpToolName: string | null;
  sessionId: string | null;
  hasError: boolean;
}

/** The list envelope: keyset-paginated on MAX(id) per trace group, newest first. */
interface TracePage {
  items: TraceSummary[];
  nextCursor?: string;
}

/** One span as GET /admin-api/traces/:traceId returns it. */
interface StoredSpan {
  id: number;
  traceId: string;
  spanId: string;
  name: string;
  mcpToolName: string | null;
  sessionId: string | null;
  startMs: number;
  endMs: number;
  /** 0 UNSET / 1 OK / 2 ERROR — `endSpan(span, ..., result.isError ? 2 : 1)`. */
  statusCode: 0 | 1 | 2;
  attributes: Record<string, string | number | boolean>;
  createdAt: number;
}

interface TraceDetail {
  traceId: string;
  spans: StoredSpan[];
}

/** One row of GET /admin-api/traces/top-sessions. */
interface TopSession {
  sessionId: string;
  calls: number;
  hasError: boolean;
}

/** One row of GET /admin-api/audit-log — only the fields the purge assertion reads. */
interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
}

// ── Local helpers (this spec owns them — e2e/support/* belongs to every spec) ─

/** `code` out of the standard `{ error: { code, message, request_id } }` envelope. */
function errorCode(body: unknown): string | undefined {
  const err = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** List traces as `auth` with the given query params. Fails loudly on a non-200. */
async function listTraces(
  request: APIRequestContext,
  auth: AdminAuth,
  query: Record<string, string> = {},
): Promise<TracePage> {
  const qs = new URLSearchParams(query).toString();
  const res = await request.get(`${APP_BASE_URL}/admin-api/traces?${qs}`, { headers: apiHeaders(auth) });
  expect(res.status(), `trace list failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as TracePage;
}

/** Fetch one trace's spans. Fails loudly on a non-200 (including the 404). */
async function getTrace(request: APIRequestContext, auth: AdminAuth, traceId: string): Promise<TraceDetail> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/traces/${traceId}`, { headers: apiHeaders(auth) });
  expect(res.status(), `trace detail ${traceId} failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as TraceDetail;
}

async function getTopSessions(request: APIRequestContext, auth: AdminAuth, limit: number): Promise<TopSession[]> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/traces/top-sessions?limit=${limit}`, {
    headers: apiHeaders(auth),
  });
  expect(res.status(), `top-sessions failed: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { items: TopSession[] }).items;
}

/** DELETE /admin-api/traces, asserting the envelope. Returns the reported span count. */
async function purgeTraces(request: APIRequestContext, auth: AdminAuth): Promise<number> {
  const res = await request.delete(`${APP_BASE_URL}/admin-api/traces`, { headers: apiHeaders(auth) });
  expect(res.status(), `purge failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { status?: string; removed?: number };
  expect(body.status).toBe("purged");
  expect(typeof body.removed, `removed was ${JSON.stringify(body.removed)}`).toBe("number");
  return typeof body.removed === "number" ? body.removed : -1;
}

/**
 * The summary for one tool out of a page. Throws rather than returning
 * undefined, so callers read its fields without a non-null assertion and a
 * missing trace fails naming the tool that was expected.
 */
function requireSummary(page: TracePage, mcpToolName: string): TraceSummary {
  const found = page.items.find((t) => t.mcpToolName === mcpToolName);
  if (!found) {
    throw new Error(`no trace for ${mcpToolName} — page held [${page.items.map((t) => t.mcpToolName).join(", ")}]`);
  }
  return found;
}

/** The single span of a one-span trace, with a clear failure when the shape changed. */
function requireOnlySpan(detail: TraceDetail): StoredSpan {
  const span = detail.spans[0];
  if (!span) throw new Error(`trace ${detail.traceId} came back with no spans`);
  return span;
}

/** The newest audit entry for an action, or null when none has been written yet. */
async function newestAuditEntry(
  request: APIRequestContext,
  auth: AdminAuth,
  action: string,
): Promise<AuditEntry | null> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/audit-log?action=${action}&limit=1`, {
    headers: apiHeaders(auth),
  });
  expect(res.status(), `audit-log read failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { items: AuditEntry[] };
  return body.items[0] ?? null;
}

// ── State established once, in beforeAll ────────────────────────────────────

/** Bearer for the data plane, minted in beforeAll. */
let authHeader: string;

/** The MCP session ids the calls below ran under — what `mcp.session_id` records. */
let tracedSessionId: string;
let teamSessionId: string;

/** Trace ids resolved after the probe (empty strings while tracing is off). */
let successTraceId = "";
let failureTraceId = "";
let teamTraceId = "";

test.describe("Trace viewer — span recording, filters, access control and the SPA", () => {
  let adminContext: BrowserContext;
  let adminPage: Page;
  let adminRequest: APIRequestContext;
  let adminAuth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    adminAuth = await loginAs(adminPage);
    adminRequest = adminContext.request;

    // Two backends: one teamless (the subject), one owned by a team (the
    // tenancy control). Both from the shared OpenAPI fixture, so both expose
    // the same two tools.
    await registerViaApi(adminRequest, adminAuth, TRACED_CLIENT);
    await registerViaApi(adminRequest, adminAuth, TEAM_CLIENT);

    for (const account of LOWER_PRIVILEGE_ACCOUNTS) {
      await createAdminUser(adminRequest, adminAuth, account);
    }
    await createAdminUser(adminRequest, adminAuth, {
      username: TEAM_ADMIN_USERNAME,
      password: TEAM_ADMIN_PASSWORD,
      role: "admin",
    });
    const teamId = await createTeam(adminRequest, adminAuth, TEAM_NAME);
    await setUserTeam(adminRequest, adminAuth, TEAM_ADMIN_USERNAME, teamId);
    await setClientTeam(adminRequest, adminAuth, TEAM_CLIENT, teamId);

    // A key so the data plane is in a known auth-required state regardless of
    // which spec ran first (see mintMcpKey's note on that transition).
    authHeader = (await mintMcpKey(adminRequest, adminAuth, "e2e-trace-key")).authHeader;

    // Clean slate — see the header note on why the counts below need one.
    await purgeTraces(adminRequest, adminAuth);

    // ── The traffic under test. Every call is ASSERTED, so if the probe below
    // reports "no span" it can only be the TRACE_STORAGE flag, never a call
    // that silently never reached proxyToolCall.
    const tracedPath = `/mcp/${TRACED_CLIENT}`;
    tracedSessionId = (await initMcpSession(tracedPath, { authHeader, clientName: "e2e-traces" })).sessionId;

    const ok = await mcpToolsCall(tracedPath, tracedSessionId, SUCCESS_TOOL_KEY, authHeader);
    expect(ok.status).toBe(200);
    expect(ok.isError, `the successful call was refused: ${ok.text}`).toBeFalsy();

    const failed = await mcpToolsCall(tracedPath, tracedSessionId, FAILURE_TOOL_KEY, authHeader, {
      name: "Ada",
      email: "ada@example.com",
    });
    expect(failed.status).toBe(200);
    expect(failed.isError, "the fixture has no POST /api/v1/users handler — this call must fail").toBe(true);

    const teamPath = `/mcp/${TEAM_CLIENT}`;
    teamSessionId = (await initMcpSession(teamPath, { authHeader, clientName: "e2e-traces-team" })).sessionId;
    const teamCall = await mcpToolsCall(teamPath, teamSessionId, TEAM_TOOL_KEY, authHeader);
    expect(teamCall.status).toBe(200);
    expect(teamCall.isError, `the team client's call was refused: ${teamCall.text}`).toBeFalsy();

    // Three tool calls have just run, and each one was asserted to have
    // reached dispatch — so an empty span table here has exactly one
    // explanation left, and it is a defect. This is deliberately an assertion
    // rather than a skip guard: an earlier draft skipped the span-dependent
    // tests whenever the probe came back empty, which made a BROKEN span writer
    // indistinguishable from a switched-off one and reported both as a green
    // run with seven skips. Verified by neutering `persistSpan`'s call site in
    // observability/tracing.ts — under the skip guard nothing failed.
    const mine = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "10" });
    expect(
      mine.items.length,
      "three dispatched tool calls recorded no spans — either TRACE_STORAGE=true is missing from " +
        "playwright.config.ts's webServer.env, or span recording is broken",
    ).toBeGreaterThan(0);

    successTraceId = requireSummary(mine, SUCCESS_TOOL_KEY).traceId;
    failureTraceId = requireSummary(mine, FAILURE_TOOL_KEY).traceId;
    const teamTraces = await listTraces(adminRequest, adminAuth, { session_id: teamSessionId, limit: "10" });
    teamTraceId = requireSummary(teamTraces, TEAM_TOOL_KEY).traceId;
  });

  test.afterAll(async () => {
    // Hand session slots back to the process-wide maxSessions budget.
    await closeTrackedMcpSessions();
    await adminContext.close();
  });

  // ── Contract that holds with or without span storage ──────────────────────

  test("every trace route is behind admin auth — no credential is 401, a rejected one is 403", async ({ request }) => {
    // The bare `request` fixture carries none of the admin context's cookies,
    // so these are genuinely unauthenticated.
    const unauthenticated = [
      await request.get(`${APP_BASE_URL}/admin-api/traces`),
      await request.get(`${APP_BASE_URL}/admin-api/traces/top-sessions`),
      await request.get(`${APP_BASE_URL}/admin-api/traces/${UNKNOWN_TRACE_ID}`),
      await request.delete(`${APP_BASE_URL}/admin-api/traces`),
    ];
    for (const res of unauthenticated) {
      expect(res.status(), `${res.url()} answered an unauthenticated caller`).toBe(401);
      expect(errorCode(await res.json())).toBe("UNAUTHORIZED");
    }

    // A Bearer IS a credential, and `adminAuth` checks it first and
    // unconditionally — with ADMIN_API_KEYS empty in the e2e env, every one of
    // them is rejected. 403, not 401: the caller offered something.
    const bogus = await request.get(`${APP_BASE_URL}/admin-api/traces`, {
      headers: { authorization: "Bearer e2e-trace-not-a-real-admin-key" },
    });
    expect(bogus.status()).toBe(403);
    expect(errorCode(await bogus.json())).toBe("FORBIDDEN");
  });

  test("the list answers the keyset envelope and survives a malformed limit", async () => {
    const page = await listTraces(adminRequest, adminAuth);
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.nextCursor === undefined || typeof page.nextCursor === "string").toBe(true);

    // `?limit=abc` reaches listTraces as NaN. clampLimit's `Number.isFinite`
    // guard is what keeps that from being bound as `LIMIT ?` — bun:sqlite
    // answers a raw "datatype mismatch" throw (a 500) rather than clamping.
    const malformed = await listTraces(adminRequest, adminAuth, { limit: "abc" });
    expect(Array.isArray(malformed.items)).toBe(true);

    // The other end of the same clamp: 0 is raised to 1, not passed through.
    const zero = await listTraces(adminRequest, adminAuth, { limit: "0" });
    expect(zero.items.length).toBeLessThanOrEqual(1);

    // An unmatched filter is an empty page, not an error.
    const nothing = await listTraces(adminRequest, adminAuth, { tool: "e2e-trace-no-such__tool" });
    expect(nothing.items).toEqual([]);
    expect(nothing.nextCursor).toBeUndefined();
  });

  test("top-sessions is its own route, not a trace id", async () => {
    // `/traces/top-sessions` is registered BEFORE `/traces/:traceId`, and only
    // that ordering keeps it from being read as a trace id and answered with a
    // 404 TRACE_NOT_FOUND. Nothing in the file's shape makes that obvious, so
    // it is pinned here.
    const res = await adminRequest.get(`${APP_BASE_URL}/admin-api/traces/top-sessions`, {
      headers: apiHeaders(adminAuth),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items?: unknown };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("an unknown trace id is refused cleanly with 404 TRACE_NOT_FOUND", async () => {
    const res = await adminRequest.get(`${APP_BASE_URL}/admin-api/traces/${UNKNOWN_TRACE_ID}`, {
      headers: apiHeaders(adminAuth),
    });
    expect(res.status()).toBe(404);
    const body = (await res.json()) as { error?: { code?: string; message?: string; request_id?: unknown } };
    expect(body.error?.code).toBe("TRACE_NOT_FOUND");
    expect(body.error?.message).toBe("Trace not found");
    // The standard envelope carries the correlation id — a handler that hand
    // -rolled its own 404 would drop it.
    expect(body.error).toHaveProperty("request_id");
  });

  // ── Contract that needs a recorded span ───────────────────────────────────

  test("a data-plane tool call is recorded as a trace naming the client and the tool", async () => {
    const summary = requireSummary(
      await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "10" }),
      SUCCESS_TOOL_KEY,
    );
    expect(summary.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(summary.spanCount).toBe(1);
    expect(summary.sessionId).toBe(tracedSessionId);
    expect(summary.endMs).toBeGreaterThanOrEqual(summary.startMs);

    // Retrievable by id, and the span itself names the client and the tool —
    // the composite key, not the bare tool name, which is the only form that
    // identifies WHICH backend ran.
    const detail = await getTrace(adminRequest, adminAuth, summary.traceId);
    expect(detail.traceId).toBe(summary.traceId);
    const span = requireOnlySpan(detail);
    expect(span.name).toBe(`tool_call ${SUCCESS_TOOL_KEY}`);
    expect(span.mcpToolName).toBe(SUCCESS_TOOL_KEY);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attributes["mcp.tool"]).toBe(SUCCESS_TOOL_KEY);
    // The session attribute is what lets an operator tie a span back to the
    // agent run that caused it rather than only to the API key.
    expect(span.attributes["mcp.session_id"]).toBe(tracedSessionId);
    expect(span.sessionId).toBe(tracedSessionId);
  });

  test("the trace records the OUTCOME — a failing call is distinguishable from a successful one", async () => {
    const page = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "10" });
    const success = requireSummary(page, SUCCESS_TOOL_KEY);
    const failure = requireSummary(page, FAILURE_TOOL_KEY);
    expect(success.traceId).not.toBe(failure.traceId);

    // The whole point: same client, same session, same envelope — the only
    // thing separating them is the outcome the span recorded.
    expect(success.hasError).toBe(false);
    expect(failure.hasError).toBe(true);

    const successSpan = requireOnlySpan(await getTrace(adminRequest, adminAuth, success.traceId));
    const failureSpan = requireOnlySpan(await getTrace(adminRequest, adminAuth, failure.traceId));
    // 1 = OK, 2 = ERROR (endSpan's `result.isError ? 2 : 1`). A regression that
    // reported UNSET (0) for everything would still render a waterfall and
    // still list both traces — and quietly lose every failure.
    expect(successSpan.statusCode).toBe(1);
    expect(failureSpan.statusCode).toBe(2);
    expect(successSpan.attributes["mcp.tool.is_error"]).toBe(false);
    expect(failureSpan.attributes["mcp.tool.is_error"]).toBe(true);
    // The upstream 404 surfaced as an MCP isError result, so it is a RECORDED
    // failure — not a dropped span, which is what a thrown transport error
    // would have produced.
    expect(failureSpan.mcpToolName).toBe(FAILURE_TOOL_KEY);
  });

  test("the list filters by tool and by session, and the cursor walks back through them", async () => {
    // `?tool=` matches the composite key exactly (the indexed mcp_tool_name
    // column), so it narrows to one tool of one client.
    const byTool = await listTraces(adminRequest, adminAuth, { tool: SUCCESS_TOOL_KEY, limit: "50" });
    expect(byTool.items.length).toBeGreaterThanOrEqual(1);
    expect(byTool.items.every((t) => t.mcpToolName === SUCCESS_TOOL_KEY)).toBe(true);

    // `?session_id=` is the other indexed column. This session made exactly the
    // two calls above, and the id is a fresh UUID, so the count is exact.
    const bySession = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "50" });
    expect(bySession.items.length).toBe(2);
    expect(bySession.items.map((t) => t.mcpToolName).sort()).toEqual([FAILURE_TOOL_KEY, SUCCESS_TOOL_KEY].sort());

    // Both filters at once must AND, not OR.
    const both = await listTraces(adminRequest, adminAuth, {
      session_id: tracedSessionId,
      tool: FAILURE_TOOL_KEY,
      limit: "50",
    });
    expect(both.items.map((t) => t.mcpToolName)).toEqual([FAILURE_TOOL_KEY]);

    // The cursor is the last returned trace's MAX(id), replayed as
    // `HAVING MAX(id) < ?`. Page two must be strictly older and disjoint — a
    // pager that dropped its cursor would re-serve page one instead.
    const first = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "1" });
    expect(first.items.length).toBe(1);
    const cursor = first.nextCursor;
    if (!cursor) throw new Error("expected a nextCursor — this session recorded two traces");

    const second = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "1", cursor });
    expect(second.items.length).toBe(1);
    expect(second.items[0].traceId).not.toBe(first.items[0].traceId);
    // Newest first: the failing call was made second, so it heads the list.
    expect(first.items[0].mcpToolName).toBe(FAILURE_TOOL_KEY);
    expect(second.items[0].mcpToolName).toBe(SUCCESS_TOOL_KEY);
    // Nothing is left after those two, so the walk terminates.
    expect(second.nextCursor).toBeUndefined();
  });

  test("top-sessions aggregates a session's calls and flags the one that errored", async () => {
    const sessions = await getTopSessions(adminRequest, adminAuth, 100);
    const traced = sessions.find((s) => s.sessionId === tracedSessionId);
    const team = sessions.find((s) => s.sessionId === teamSessionId);
    if (!traced || !team) {
      throw new Error(`missing a session in [${sessions.map((s) => `${s.sessionId}:${s.calls}`).join(", ")}]`);
    }

    // Two spans under one session id collapse to one row with calls=2 — the
    // "which agent run is causing this spike" summary. The error flag is
    // MAX(status_code)===2, so one bad call in an otherwise healthy session
    // still marks it.
    expect(traced.calls).toBe(2);
    expect(traced.hasError).toBe(true);
    expect(team.calls).toBe(1);
    expect(team.hasError).toBe(false);
  });

  // ── The SPA ───────────────────────────────────────────────────────────────

  test("the SPA trace page renders, names the flag it depends on, and reports an unknown id", async () => {
    const listed = adminPage.waitForResponse((r) => r.url().includes("/admin-api/traces?"));
    await adminPage.goto("/admin/traces");
    await expect(adminPage.getByRole("heading", { name: "Traces", level: 1 })).toBeVisible();
    expect((await listed).status(), "the trace list request failed").toBe(200);

    // The page tells an operator which server flag an empty list may be down
    // to. That hint is the difference between "nothing happened" and "you
    // never turned it on" — assert the literal env var, not just some prose.
    await expect(adminPage.locator("p.subtitle code")).toHaveText("TRACE_STORAGE=true");

    // The detail route's failure branch. The backend answers 404 TRACE_NOT_FOUND
    // with its own English message ("Trace not found"); what the user sees is
    // this UI's sentence for that CODE, from `errors.api.*` in the locale
    // bundles — which is what lets a Spanish operator read a Spanish failure.
    // Asserting the localized string (not the server's) is the point: it proves
    // the code round-tripped through the lookup rather than falling back.
    await adminPage.goto(`/admin/traces/${UNKNOWN_TRACE_ID}`);
    await expect(adminPage.getByRole("heading", { name: `Trace ${UNKNOWN_TRACE_ID}`, level: 1 })).toBeVisible();
    await expect(adminPage.locator("p.error[role='alert']")).toHaveText("That trace no longer exists.");
  });

  test("the SPA lists the trace and its detail page renders the span waterfall", async () => {
    await adminPage.goto("/admin/traces");
    const row = adminPage.locator("table.data-table tbody tr").filter({ hasText: SUCCESS_TOOL_KEY }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("OK");

    // Click the first cell rather than the row: the session cell holds a
    // button with `@click.stop`, and a centred row click can land on it.
    await row.locator("td").first().click();
    await expect(adminPage).toHaveURL(new RegExp(`/admin/traces/${successTraceId}$`));
    await expect(adminPage.getByRole("heading", { name: `Trace ${successTraceId}`, level: 1 })).toBeVisible();

    // DB -> admin API -> waterfall: the bar is labelled with the span name, and
    // the attributes pane shows the raw bag the span carried.
    await expect(adminPage.locator(".waterfall-label")).toHaveText(`tool_call ${SUCCESS_TOOL_KEY}`);
    await expect(adminPage.locator(".attrs pre")).toContainText(SUCCESS_TOOL_KEY);
    await expect(adminPage.locator(".attrs pre")).toContainText("mcp.session_id");
    // A successful span is NOT drawn as an error…
    await expect(adminPage.locator(".waterfall-bar.hot")).toHaveCount(0);

    // …and the failing one is. This is the outcome assertion closing through
    // the UI, where an operator actually reads it.
    await adminPage.goto(`/admin/traces/${failureTraceId}`);
    await expect(adminPage.locator(".waterfall-label")).toHaveText(`tool_call ${FAILURE_TOOL_KEY}`);
    await expect(adminPage.locator(".waterfall-bar.hot")).toHaveCount(1);
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  test("a team-scoped admin sees only its own team's traces", async ({ browser }) => {
    // A fresh, isolated context so this session doesn't inherit the
    // super-admin's cookies from the shared one above.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const teamAuth = await loginAs(page, TEAM_ADMIN_USERNAME, TEAM_ADMIN_PASSWORD);
      const scopedRequest = context.request;

      // The scope is derived from `mcp_tool_name`'s `clientName__` prefix
      // matched against the caller's team's clients — so a team admin sees its
      // own client's traces and none of the teamless client's.
      const scoped = await listTraces(scopedRequest, teamAuth, { limit: "200" });
      const tools = scoped.items.map((t) => t.mcpToolName);
      expect(tools, "positive control — the team's own trace must come back").toContain(TEAM_TOOL_KEY);
      expect(tools).not.toContain(SUCCESS_TOOL_KEY);
      expect(tools).not.toContain(FAILURE_TOOL_KEY);

      // Fail-closed on the direct lookup too: a cross-tenant trace id is
      // answered exactly like one that never existed, so a scoped caller
      // cannot even probe for existence.
      const cross = await scopedRequest.get(`${APP_BASE_URL}/admin-api/traces/${successTraceId}`, {
        headers: apiHeaders(teamAuth),
      });
      expect(cross.status()).toBe(404);
      expect(errorCode(await cross.json())).toBe("TRACE_NOT_FOUND");

      // Same request shape against its own trace succeeds — so the 404 above
      // is the tenancy scope, not a broken endpoint.
      const own = await getTrace(scopedRequest, teamAuth, teamTraceId);
      expect(requireOnlySpan(own).mcpToolName).toBe(TEAM_TOOL_KEY);

      // The aggregate is scoped by the same condition; a summary that leaked
      // would expose another tenant's session ids and call volumes.
      const sessions = (await getTopSessions(scopedRequest, teamAuth, 100)).map((s) => s.sessionId);
      expect(sessions).toContain(teamSessionId);
      expect(sessions).not.toContain(tracedSessionId);
    } finally {
      await context.close();
    }
  });

  // ── Purge (last: it empties the table) ────────────────────────────────────

  test("purging is admin-only — an operator and a viewer are refused, though both may read", async ({ browser }) => {
    for (const account of LOWER_PRIVILEGE_ACCOUNTS) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const auth = await loginAs(page, account.username, account.password);
        const headers = apiHeaders(auth);

        const refused = await context.request.delete(`${APP_BASE_URL}/admin-api/traces`, { headers });
        expect(refused.status(), `${account.role} was allowed to purge traces`).toBe(403);
        const body = (await refused.json()) as { error?: { code?: string; message?: string } };
        expect(body.error?.code).toBe("FORBIDDEN");
        // The real message, so a gate swapped for a different one (super-admin,
        // operator, CSRF) fails here instead of passing on the status alone.
        expect(body.error?.message).toBe("This action requires the admin role");

        // Reading is NOT admin-gated — src/routes/traces.ts puts
        // `requireAdminRole` on the DELETE only. Asserting the allowance keeps
        // the 403 above meaningful (both accounts do reach the router) and
        // pins the read tier, which is otherwise invisible.
        const list = await context.request.get(`${APP_BASE_URL}/admin-api/traces?limit=1`, { headers });
        expect(list.status(), `${account.role} was refused a trace read`).toBe(200);
        const top = await context.request.get(`${APP_BASE_URL}/admin-api/traces/top-sessions`, { headers });
        expect(top.status(), `${account.role} was refused the top-sessions read`).toBe(200);
      } finally {
        await context.close();
      }
    }
  });

  test("an admin's purge actually clears the recorded spans", async () => {
    const before = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "50" });
    expect(before.items.length).toBe(2);

    // >= rather than ===: `removed` counts SPANS across the whole table, and a
    // background schedule may have contributed one since beforeAll's purge.
    const removed = await purgeTraces(adminRequest, adminAuth);
    expect(removed).toBeGreaterThanOrEqual(3); // 2 traced + 1 team

    const after = await listTraces(adminRequest, adminAuth, { session_id: tracedSessionId, limit: "50" });
    expect(after.items).toEqual([]);

    // The detail lookup follows the list — a purge that only hid rows from the
    // GROUP BY would still serve them here.
    const gone = await adminRequest.get(`${APP_BASE_URL}/admin-api/traces/${successTraceId}`, {
      headers: apiHeaders(adminAuth),
    });
    expect(gone.status()).toBe(404);
    expect(errorCode(await gone.json())).toBe("TRACE_NOT_FOUND");
  });

  test("the purge answers a removed count and is recorded in the audit log", async () => {
    // Runs whether or not anything was stored: the envelope and the audit row
    // are the purge's contract, and a purge of zero rows must still be
    // attributable — deleting observability data is exactly the kind of action
    // an audit trail exists for.
    const previous = await newestAuditEntry(adminRequest, adminAuth, "traces.purge");

    const removed = await purgeTraces(adminRequest, adminAuth);
    expect(removed).toBeGreaterThanOrEqual(0);

    const entry = await newestAuditEntry(adminRequest, adminAuth, "traces.purge");
    if (!entry) throw new Error("the purge wrote no audit entry");
    // A NEW row, not the one beforeAll's own purge left behind.
    expect(entry.id).toBeGreaterThan(previous?.id ?? 0);
    expect(entry.actor).toBe(BOOTSTRAP_ADMIN_USERNAME);
    expect(entry.action).toBe("traces.purge");
    expect(entry.target).toBe("traces");
    expect(entry.detail?.removed).toBe(removed);

    // And this spec's own traffic really is gone afterwards — the state the
    // next run starts from. Scoped to this spec's sessions rather than
    // asserting a globally empty table: synthetic monitors (src/observability/
    // monitor.ts) call `proxyToolCall` from a background loop with no session
    // id, so an unfiltered "must be empty" would race whatever a monitor
    // another spec left enabled happens to do in the same millisecond.
    for (const sessionId of [tracedSessionId, teamSessionId]) {
      const after = await listTraces(adminRequest, adminAuth, { session_id: sessionId, limit: "50" });
      expect(after.items, `traces for session ${sessionId} survived the purge`).toEqual([]);
    }
  });
});
