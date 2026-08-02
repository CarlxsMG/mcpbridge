/**
 * End-to-end test for the human-in-the-loop approvals workflow — the governance
 * feature with the strongest promise and, until now, no coverage of that promise
 * being kept over the wire.
 *
 * What this proves that the backend unit tests don't. `decideApproval` and
 * `consumeApproval` are pure DB functions; their tests call them directly and
 * assert on the row they wrote. None of that shows whether a real MCP client,
 * calling a real tool over the real transport, is actually *stopped*. That is
 * the entire point of the feature, and it lives in `checkQuarantineAndApprovalGate`
 * (src/proxy/gates.ts) — reached from `dispatchToolCall` in src/proxy/proxy.ts,
 * at the dispatch point, because MCP multiplexes every tool over one route and
 * no Express middleware can see which tool a JSON-RPC body names. A gate that
 * files a perfectly good ticket and then dispatches anyway writes exactly the
 * rows the unit tests assert on, while executing every high-risk call it was
 * installed to hold back. So every scenario below is anchored on the fixture
 * upstream's per-path hit counter (support/fixture-server.ts, read via
 * `fixtureState`): a blocked call must move it by ZERO.
 *
 * ── The state machine, read from src/admin/entities/approvals.ts ─────────────
 * A tool is gated by `PATCH /admin-api/clients/:c/tools/:t` with body key
 * `requiresApproval` (+ optional `approvalLevels`, 1..MAX_APPROVAL_LEVELS=10),
 * which writes `tool_approval`. Thereafter, per call:
 *
 *   no __approval_id  -> createApproval() files a 'pending' ticket bound to
 *                        sha256(stableStringify(args minus __approval_id/__confirm)),
 *                        snapshotting the tool's requiredLevels ONTO the ticket,
 *                        and the call returns an isError result naming the id.
 *   __approval_id: N  -> consumeApproval() must find a ticket for this exact
 *                        client+tool, with a matching args hash, status
 *                        'approved', and consumed_at NULL. It then CASes
 *                        consumed_at (single-use) and the call proceeds.
 *
 * Decisions are rows in `approval_decisions` with UNIQUE(approval_id, decided_by):
 * one actor, one decision, ever. A reject is an immediate terminal veto; an
 * approve only flips the ticket once the count of distinct approvers reaches the
 * ticket's snapshotted `requiredLevels`. 'approved' and 'rejected' are both
 * terminal — `decideApproval` refuses anything not still 'pending'.
 *
 * ── APPROVAL DOES NOT RESUME THE CALL ────────────────────────────────────────
 * There is no resume machinery anywhere in the source: MCP is synchronous
 * request/response, the original call already returned, and nothing holds it.
 * The contract is RETRY — the caller re-invokes with `{"__approval_id": N}` and
 * the ticket is consumed then. Asserted explicitly below, because the SPA's own
 * confirm copy claims otherwise ("This will let {client}'s pending call to
 * {tool} run immediately", pages.approvals.confirm.approve_message) — see the
 * findings note on that test.
 *
 * ── Cleanup is load-bearing ──────────────────────────────────────────────────
 * `tool_approval` is durable admin config in the database every spec shares. A
 * tool left gated would queue — and fail — every later call to it, so afterAll
 * clears the flag on all five tools AND unregisters the client outright.
 * Nothing here touches team assignment: the bootstrap admin must stay teamless
 * (LAST_SUPERADMIN_PROTECTED, and bundles.spec.ts depends on it).
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { APP_BASE_URL, BOOTSTRAP_ADMIN_USERNAME, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import {
  apiHeaders,
  createAdminUser,
  deleteClient,
  fixtureState,
  loginAs,
  mintMcpKey,
  registerViaApi,
  type AdminAuth,
} from "./support/admin";
import { initMcpSession, mcpToolsCall, type McpCallResult } from "./support/mcp";

// ── Fixtures under test ──────────────────────────────────────────────────────

const SERVER = "e2e-approval-api";

/**
 * One client, five gated tools — a tool is the unit of approval config, so
 * separate scenarios only need separate TOOLS, not separate clients (unlike
 * guard-enforcement.spec.ts, whose per-tool rate-limit windows can't be reset).
 * Each maps to a distinct upstream path so a scenario's hit-count delta can
 * never be confused with a sibling scenario's.
 *
 * Registered against the e2e-only EXTENDED OpenAPI document — the shared
 * fixture only declares `list-users`/`create-user`.
 */
const GATED = { tool: "echo", path: "/api/v1/echo" } as const;
const REJECTED = { tool: "list-users", path: "/api/v1/users" } as const;
const MULTI = { tool: "flaky", path: "/api/v1/flaky" } as const;
const SELF = { tool: "slow", path: "/api/v1/slow" } as const;
const UI = { tool: "get-secret", path: "/api/v1/secret" } as const;
const ALL_TOOLS = [GATED, REJECTED, MULTI, SELF, UI] as const;

/** The N-of-M threshold the multi-level scenario configures on MULTI.tool. */
const REQUIRED_LEVELS = 2;

/**
 * Two distinct operator accounts. `approval_decisions` is UNIQUE on
 * (approval_id, decided_by) and `decided_by` is the acting USERNAME, so
 * "2 levels" is only satisfiable by two different humans — one account
 * approving twice is a 409, which is exactly what makes the threshold mean
 * something. Passwords are >= 12 chars (the user-create rule).
 */
const OP_A = { username: "e2e-approval-op-a", password: "e2e-approval-op-a-pw-2026", role: "operator" } as const;
const OP_B = { username: "e2e-approval-op-b", password: "e2e-approval-op-b-pw-2026", role: "operator" } as const;

/** Below the operator tier — both must be refused the approve/reject actions. */
const LOWER_PRIVILEGE = [
  { username: "e2e-approval-viewer", password: "e2e-approval-viewer-pw-2026", role: "viewer" },
  { username: "e2e-approval-auditor", password: "e2e-approval-auditor-pw-2026", role: "auditor" },
] as const;

/**
 * `runApprovalGate`'s ticket-filed result, asserted as a full shape rather than
 * a substring: the id and the ready-to-paste retry snippet are the only
 * actionable parts of the message for an agent that just got blocked, and a
 * regression that drops either leaves the caller with no way forward.
 */
const PENDING_RESULT =
  /^Tool '(.+?)' requires human approval\. Queued as approval #(\d+)\. Once approved, re-call with \{"__approval_id": (\d+)\}\.$/;

/** Bearer for the data plane, and the key id the tickets should be attributed to. */
let authHeader: string;
let mcpKeyId: number;
/** One long-lived data-plane session for the whole spec (sessions are a capped resource). */
let session: { path: string; sessionId: string };

// ── Response narrowing (TS strict: no `any`, no non-null assertions) ─────────

/** An approval ticket as GET /admin-api/approvals returns it (ApprovalRecord). */
interface ApprovalTicket {
  id: number;
  clientName: string;
  toolName: string;
  argsHash: string;
  argsJson: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
  consumedAt: number | null;
  requestedBy: number | null;
  requiredLevels: number;
  decisions: { id: number; decidedBy: string; decision: "approved" | "rejected"; note: string | null }[];
}

/** The approve/reject response, or the standard error envelope on a refusal. */
interface DecisionBody {
  status?: string;
  id?: number;
  approvalsReceived?: number;
  requiredLevels?: number;
  error?: { code?: string; message?: string };
}

/** One audit row, as GET /admin-api/audit-log returns it. */
interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
}

// ── Local helpers (this spec owns them — e2e/support/* belongs to every spec) ─

/** Enable/disable the approval requirement, optionally with an N-of-M threshold. */
async function setApprovalRequired(
  request: APIRequestContext,
  auth: AdminAuth,
  tool: string,
  requiresApproval: boolean,
  approvalLevels?: number,
): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${tool}`, {
    headers: apiHeaders(auth),
    data: approvalLevels === undefined ? { requiresApproval } : { requiresApproval, approvalLevels },
  });
  expect(res.status(), `requiresApproval=${requiresApproval} on ${tool}: ${await res.text()}`).toBe(200);
}

/** Best-effort clear for afterAll — must never throw, or the client below leaks. */
async function clearApprovalQuietly(request: APIRequestContext, auth: AdminAuth, tool: string): Promise<void> {
  try {
    await request.patch(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${tool}`, {
      headers: apiHeaders(auth),
      data: { requiresApproval: false },
    });
  } catch {
    // Swallowed on purpose: unregistering the client below is the real backstop.
  }
}

/** tools/call on the shared session, addressed as `client__tool`. */
async function callTool(tool: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
  return mcpToolsCall(session.path, session.sessionId, `${SERVER}__${tool}`, authHeader, args);
}

/** The fixture upstream's current hit count for one path (0 when never called). */
async function upstreamHits(request: APIRequestContext, path: string): Promise<number> {
  const { hits } = await fixtureState(request);
  return hits[path] ?? 0;
}

/**
 * Runs `fn` and reports how many times the upstream path was hit while it ran.
 * The whole spec turns on this number: `workers: 1` + `fullyParallel: false`
 * (playwright.config.ts) means nothing else is driving the bridge inside the
 * window, and the bridge's health loop probes `/health` — never these paths.
 */
async function withUpstreamDelta<T>(
  request: APIRequestContext,
  path: string,
  fn: () => Promise<T>,
): Promise<{ value: T; delta: number }> {
  const before = await upstreamHits(request, path);
  const value = await fn();
  const after = await upstreamHits(request, path);
  return { value, delta: after - before };
}

/**
 * Calls a gated tool with no ticket and returns the id of the ticket that got
 * filed, asserting the caller-facing shape on the way through. Throws rather
 * than returning undefined so callers can use the id without a non-null
 * assertion, and so a broken gate fails here naming what it actually returned.
 */
async function fileTicket(tool: string, args: Record<string, unknown> = {}): Promise<number> {
  const res = await callTool(tool, args);
  expect(res.status, `gated call to ${tool} was not a 200 JSON-RPC envelope`).toBe(200);
  // A queued call is an MCP-level error inside a healthy transport — the session
  // survives, so an agent can go get its approval and come back.
  expect(res.isError, `gated call to ${tool} was not refused: ${res.text}`).toBe(true);
  const match = PENDING_RESULT.exec(res.text ?? "");
  if (!match) throw new Error(`unexpected pending result for ${tool}: ${res.text}`);
  expect(match[1]).toBe(`${SERVER}__${tool}`);
  // The id in the prose and the id in the retry snippet are the same ticket —
  // an agent that copies the snippet must not be sent to a different ticket.
  expect(match[3]).toBe(match[2]);
  return Number(match[2]);
}

/** Read one ticket back out of the admin queue. Throws when it isn't listed. */
async function fetchTicket(request: APIRequestContext, auth: AdminAuth, id: number): Promise<ApprovalTicket> {
  const res = await request.get(`${APP_BASE_URL}/admin-api/approvals`, { headers: apiHeaders(auth) });
  expect(res.status(), `approvals list failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { items: ApprovalTicket[] };
  const found = body.items.find((t) => t.id === id);
  if (!found) throw new Error(`approval #${id} is not in the admin queue`);
  return found;
}

/** POST approve/reject as some caller. Returns the raw verdict for the caller to assert. */
async function decide(
  request: APIRequestContext,
  auth: AdminAuth,
  id: number,
  action: "approve" | "reject",
  note?: string,
): Promise<{ status: number; body: DecisionBody }> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/approvals/${id}/${action}`, {
    headers: apiHeaders(auth),
    data: note === undefined ? {} : { note },
  });
  return { status: res.status(), body: (await res.json()) as DecisionBody };
}

/** Audit rows matching a filter, newest first. Requires an operator+ caller. */
async function auditRows(
  request: APIRequestContext,
  auth: AdminAuth,
  query: Record<string, string>,
): Promise<AuditEntry[]> {
  const qs = new URLSearchParams(query).toString();
  const res = await request.get(`${APP_BASE_URL}/admin-api/audit-log?${qs}`, { headers: apiHeaders(auth) });
  expect(res.status(), `audit-log read failed: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { items: AuditEntry[] }).items;
}

/**
 * The SPA queue row for one ticket.
 *
 * Matched on the id CELL, not on the row's text: Playwright's `hasText` is a
 * substring match over the whole row, and every row renders a formatted
 * timestamp, so filtering on a bare id like "7" matches nearly all of them. The
 * `td.mono` regex pins the one cell that holds the id (the other `td.mono` is
 * `client/tool`, which never matches `^\d+$`), and the client/tool filter keeps
 * it unambiguous even when a local re-run has left older tickets for the same
 * tool in the queue.
 */
function approvalRow(page: Page, id: number, tool: string): Locator {
  return page
    .locator("table.data-table tbody tr")
    .filter({ has: page.locator("td.mono", { hasText: new RegExp(`^${id}$`) }) })
    .filter({ hasText: `${SERVER}/${tool}` });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test.describe("multi-level approvals — the dispatch gate, the queue and the decision surface", () => {
  let adminContext: BrowserContext;
  let adminPage: Page;
  let adminRequest: APIRequestContext;
  let adminAuth: AdminAuth;

  let opAContext: BrowserContext;
  let opARequest: APIRequestContext;
  let opAAuth: AdminAuth;

  let opBContext: BrowserContext;
  let opBRequest: APIRequestContext;
  let opBAuth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    // Setup is four logins, four account creations, a registration and five
    // config PATCHes; the default timeout is sized for one test, not for this.
    test.setTimeout(120_000);

    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    adminAuth = await loginAs(adminPage);
    adminRequest = adminContext.request;

    await registerViaApi(adminRequest, adminAuth, SERVER, FIXTURE_OPENAPI_EXTENDED_PATH);

    for (const account of [OP_A, OP_B, ...LOWER_PRIVILEGE]) {
      await createAdminUser(adminRequest, adminAuth, account);
    }

    // Separate contexts so no operator session ever inherits the super-admin's
    // cookies — `decided_by` is read from the session, and the multi-level
    // threshold is only meaningful if the two approvers really are two accounts.
    opAContext = await browser.newContext();
    opAAuth = await loginAs(await opAContext.newPage(), OP_A.username, OP_A.password);
    opARequest = opAContext.request;

    opBContext = await browser.newContext();
    opBAuth = await loginAs(await opBContext.newPage(), OP_B.username, OP_B.password);
    opBRequest = opBContext.request;

    // Gate every tool up front, each with an EXPLICIT threshold. Omitting
    // `approvalLevels` makes `setApprovalRequired` keep whatever the tool
    // already had (`getRequiredLevels`), and `reuseExistingServer` means a local
    // re-run meets the config the previous run left behind — so the "default is
    // 1 level" assertion below would silently inherit 2 from an earlier run.
    for (const { tool } of ALL_TOOLS) {
      await setApprovalRequired(adminRequest, adminAuth, tool, true, 1);
    }
    await setApprovalRequired(adminRequest, adminAuth, MULTI.tool, true, REQUIRED_LEVELS);

    // Mint a key so the data plane is in a known auth-required state whichever
    // spec ran first, and so tickets have a requester id to attribute.
    const minted = await mintMcpKey(adminRequest, adminAuth, "e2e-approval");
    authHeader = minted.authHeader;
    mcpKeyId = minted.id;

    const path = `/mcp/${SERVER}`;
    const { sessionId } = await initMcpSession(path, { authHeader, clientName: "e2e-approval" });
    session = { path, sessionId };
  });

  test.afterAll(async () => {
    // Hand the session slot back before anything else — the gateway caps
    // concurrent sessions and only expires idle ones after 30 minutes.
    await fetch(`${APP_BASE_URL}${session.path}`, {
      method: "DELETE",
      headers: { "mcp-session-id": session.sessionId, authorization: authHeader },
    });

    try {
      // `tool_approval` is durable config in the shared database: a tool left
      // gated would queue every later spec's calls to it instead of running them.
      for (const { tool } of ALL_TOOLS) {
        await clearApprovalQuietly(adminRequest, adminAuth, tool);
      }
      // Belt and braces — unregistering removes the tools the flags hang off.
      await deleteClient(adminRequest, adminAuth, SERVER);
    } finally {
      await adminContext.close();
      await opAContext.close();
      await opBContext.close();
    }
  });

  // ── (1) The security assertion: the gate stops the call ───────────────────

  test("a gated call files a ticket and never reaches the upstream", async () => {
    const { value: id, delta } = await withUpstreamDelta(adminRequest, GATED.path, () => fileTicket(GATED.tool));

    // THE assertion this whole file exists for. A gate that files the ticket and
    // dispatches anyway produces an identical ticket row, an identical caller
    // message, and a perfectly green unit test — while running every high-risk
    // call it was installed to hold back.
    expect(delta, "the upstream was called for a request that was only QUEUED for approval").toBe(0);

    const ticket = await fetchTicket(adminRequest, adminAuth, id);
    expect(ticket.status).toBe("pending");
    expect(ticket.clientName).toBe(SERVER);
    expect(ticket.toolName).toBe(GATED.tool);
    expect(ticket.decisions).toEqual([]);
    expect(ticket.decidedAt).toBeNull();
    expect(ticket.consumedAt).toBeNull();
    // Default threshold when `approvalLevels` was never set (getRequiredLevels).
    expect(ticket.requiredLevels).toBe(1);
    // The requester IS captured for a data-plane call — the managed key's id.
    // Worth pinning because of what is NOT done with it; see the self-approval
    // test at the bottom.
    expect(ticket.requestedBy).toBe(mcpKeyId);
    // The queue carries the call's raw arguments, which is what the ticket binds to.
    expect(JSON.parse(ticket.argsJson)).toEqual({});
  });

  // ── (2) Approval does not resume — the caller retries ─────────────────────

  test("approving does not resume the call; re-invoking with __approval_id does", async () => {
    const id = await fileTicket(GATED.tool);

    const { value: verdict, delta: deltaOnApprove } = await withUpstreamDelta(adminRequest, GATED.path, async () => {
      const v = await decide(opARequest, opAAuth, id, "approve", "e2e approve note");
      // An intervening round trip, so a hypothetical async resume would have had
      // real event-loop turns to fire before the hit count is read back.
      const t = await fetchTicket(adminRequest, adminAuth, id);
      expect(t.status).toBe("approved");
      expect(t.decidedBy).toBe(OP_A.username);
      expect(t.note).toBe("e2e approve note");
      // Approved but NOT yet spent: the ticket is consumed by the retry, not by
      // the decision. This is the field that distinguishes the two models.
      expect(t.consumedAt).toBeNull();
      expect(t.decisions.map((d) => [d.decidedBy, d.decision])).toEqual([[OP_A.username, "approved"]]);
      return v;
    });

    expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
    expect(verdict.body.status).toBe("approved");
    expect(verdict.body.id).toBe(id);
    expect(verdict.body.approvalsReceived).toBe(1);
    expect(verdict.body.requiredLevels).toBe(1);

    // There is no resume machinery in the source — MCP is synchronous and the
    // original call already returned — so approving alone must move nothing.
    // FINDING: the SPA's confirm copy says approving "will let {client}'s
    // pending call to {tool} run immediately", which is not what happens.
    expect(deltaOnApprove, "approving a ticket dispatched the call on its own").toBe(0);

    // The documented contract: re-invoke carrying the ticket.
    const { value: retry, delta: deltaOnRetry } = await withUpstreamDelta(adminRequest, GATED.path, () =>
      callTool(GATED.tool, { __approval_id: id }),
    );
    expect(retry.status).toBe(200);
    expect(retry.isError, `approved retry was still refused: ${retry.text}`).toBeFalsy();
    // /api/v1/echo reflects what the bridge sent upstream, so a real round trip
    // is visible in the payload rather than inferred from the absence of an error.
    expect(retry.text).toContain("host");
    expect(deltaOnRetry, "the approved retry did not reach the upstream exactly once").toBe(1);

    // …and the ticket is spent, so a replay of the identical call is refused.
    const { value: replay, delta: deltaOnReplay } = await withUpstreamDelta(adminRequest, GATED.path, () =>
      callTool(GATED.tool, { __approval_id: id }),
    );
    expect(replay.isError).toBe(true);
    expect(replay.text).toBe(`Approval #${id} was already used`);
    expect(deltaOnReplay, "a spent ticket still let the call through").toBe(0);
  });

  // ── (3) The ticket is bound to the exact arguments ────────────────────────

  test("an approved ticket cannot be spent on different arguments", async () => {
    // The reason the ticket carries an args HASH at all: without it, an approval
    // granted for `{limit: 1}` would authorise any later call to the same tool,
    // and the human reviewing the queue would have approved a payload that never
    // ran. `approvalArgsHash` excludes only the control keys (__approval_id,
    // __confirm), so the retry below differs from the ticket in a REAL argument.
    const id = await fileTicket(REJECTED.tool, { limit: 1 });
    const approved = await decide(opARequest, opAAuth, id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const { value: tampered, delta } = await withUpstreamDelta(adminRequest, REJECTED.path, () =>
      callTool(REJECTED.tool, { limit: 2, __approval_id: id }),
    );
    expect(tampered.isError).toBe(true);
    expect(tampered.text).toBe(`Approval #${id} was issued for different arguments`);
    expect(delta, "a ticket issued for other arguments still reached the upstream").toBe(0);

    // Positive control: the SAME ticket, with the arguments it was issued for,
    // still works — so the refusal above is the args binding and not a ticket
    // the mismatch quietly consumed or invalidated.
    const { value: honest, delta: honestDelta } = await withUpstreamDelta(adminRequest, REJECTED.path, () =>
      callTool(REJECTED.tool, { limit: 1, __approval_id: id }),
    );
    expect(honest.isError, `matching retry was refused: ${honest.text}`).toBeFalsy();
    expect(honest.text).toContain("Ada Lovelace");
    expect(honestDelta).toBe(1);
  });

  // ── (4) Rejection blocks, and is terminal ─────────────────────────────────

  test("a rejected ticket blocks the call and cannot later be approved into one", async () => {
    const id = await fileTicket(REJECTED.tool, { limit: 3 });

    const verdict = await decide(opARequest, opAAuth, id, "reject", "denied by e2e");
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
    // The reject response deliberately carries no counts — a rejection is a
    // terminal veto by ONE actor regardless of the N-of-M threshold, so there is
    // no "1 of 2 rejections" state to report.
    expect(verdict.body.status).toBe("rejected");
    expect(verdict.body.id).toBe(id);

    const { value: blocked, delta } = await withUpstreamDelta(adminRequest, REJECTED.path, () =>
      callTool(REJECTED.tool, { limit: 3, __approval_id: id }),
    );
    expect(blocked.isError).toBe(true);
    // consumeApproval appends the reviewer's note, so the caller learns WHY.
    expect(blocked.text).toBe(`Approval #${id} was rejected: denied by e2e`);
    expect(delta, "a rejected call reached the upstream anyway").toBe(0);

    // Terminal means terminal: not even a second, different operator can revive
    // it. `decideApproval` refuses anything whose status is no longer 'pending',
    // and the route maps that to 409 NOT_PENDING.
    const revive = await decide(opBRequest, opBAuth, id, "approve");
    expect(revive.status, JSON.stringify(revive.body)).toBe(409);
    expect(revive.body.error?.code).toBe("NOT_PENDING");

    const stillRejected = await fetchTicket(adminRequest, adminAuth, id);
    expect(stillRejected.status).toBe("rejected");
    expect(stillRejected.consumedAt).toBeNull();

    // And the call is still blocked after the failed revival attempt.
    const { value: after, delta: afterDelta } = await withUpstreamDelta(adminRequest, REJECTED.path, () =>
      callTool(REJECTED.tool, { limit: 3, __approval_id: id }),
    );
    expect(after.isError).toBe(true);
    expect(after.text).toBe(`Approval #${id} was rejected: denied by e2e`);
    expect(afterDelta).toBe(0);
  });

  // ── (5) The "multi-level" in the feature name ─────────────────────────────

  test("a 2-of-N tool needs two DISTINCT approvers; one approval does not unblock it", async () => {
    await setApprovalRequired(adminRequest, adminAuth, MULTI.tool, true, REQUIRED_LEVELS);
    const id = await fileTicket(MULTI.tool);

    const filed = await fetchTicket(adminRequest, adminAuth, id);
    // Snapshotted onto the ticket at creation, not read live: lowering the
    // tool's threshold later must not retroactively approve tickets already in
    // the queue that a second reviewer has not yet seen.
    expect(filed.requiredLevels).toBe(REQUIRED_LEVELS);

    // First approval — recorded, but the ticket stays pending.
    const first = await decide(opARequest, opAAuth, id, "approve", "first of two");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe("pending");
    expect(first.body.approvalsReceived).toBe(1);
    expect(first.body.requiredLevels).toBe(REQUIRED_LEVELS);
    expect((await fetchTicket(adminRequest, adminAuth, id)).status).toBe("pending");

    // The part most likely to be subtly wrong: one approval must NOT be enough
    // to spend the ticket. A threshold that gates only the displayed status
    // while `consumeApproval` waves the call through is the bug this catches.
    const { value: tooEarly, delta } = await withUpstreamDelta(adminRequest, MULTI.path, () =>
      callTool(MULTI.tool, { __approval_id: id }),
    );
    expect(tooEarly.isError).toBe(true);
    expect(tooEarly.text).toBe(`Approval #${id} is still pending`);
    expect(delta, "a 2-of-2 ticket ran the call after only one approval").toBe(0);

    // The same operator cannot supply the second level — UNIQUE(approval_id,
    // decided_by) is what makes "2 levels" mean "2 people" rather than "2
    // clicks". Without this, the whole threshold is decorative.
    const doubleDip = await decide(opARequest, opAAuth, id, "approve", "again");
    expect(doubleDip.status, JSON.stringify(doubleDip.body)).toBe(409);
    expect(doubleDip.body.error?.code).toBe("NOT_PENDING");
    expect(doubleDip.body.error?.message).toBe(`You already recorded a decision for approval #${id}`);

    // A second, genuinely different operator closes it out.
    const second = await decide(opBRequest, opBAuth, id, "approve", "second of two");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe("approved");
    expect(second.body.approvalsReceived).toBe(REQUIRED_LEVELS);

    const decided = await fetchTicket(adminRequest, adminAuth, id);
    expect(decided.status).toBe("approved");
    expect(decided.decisions.map((d) => d.decidedBy).sort()).toEqual([OP_A.username, OP_B.username]);

    const { value: allowed, delta: allowedDelta } = await withUpstreamDelta(adminRequest, MULTI.path, () =>
      callTool(MULTI.tool, { __approval_id: id }),
    );
    expect(allowed.isError, `fully-approved retry was refused: ${allowed.text}`).toBeFalsy();
    expect(allowedDelta, "the fully-approved retry did not reach the upstream").toBe(1);
  });

  // ── (6) Who may decide ────────────────────────────────────────────────────

  test("reading and deciding are operator-gated — a viewer and an auditor are refused (403)", async ({ browser }) => {
    const id = await fileTicket(GATED.tool);

    for (const account of LOWER_PRIVILEGE) {
      // A fresh context per account so neither inherits an operator's cookies.
      const context = await browser.newContext();
      try {
        const auth = await loginAs(await context.newPage(), account.username, account.password);

        for (const action of ["approve", "reject"] as const) {
          const res = await context.request.post(`${APP_BASE_URL}/admin-api/approvals/${id}/${action}`, {
            headers: apiHeaders(auth),
            data: {},
          });
          // 403, not the 404 the client-scoped routes use: `requireOperator`
          // guards a capability, so there is no resource existence to hide.
          expect(res.status(), `${account.role} was allowed to ${action} an approval`).toBe(403);
          expect(((await res.json()) as DecisionBody).error?.code).toBe("FORBIDDEN");
        }

        // READING the queue is gated too, not just deciding. It shipped without
        // the gate — the only route in approvals.ts without one — which let a
        // viewer or auditor read every ticket in their team's queue, including
        // each `argsJson`: the unredacted arguments of a call somebody judged
        // risky enough to require a human. Sensitivity is the same argument the
        // route's own comment makes by pointing at traffic.ts, whose reads were
        // raised to operator+ in an earlier pass.
        const queue = await context.request.get(`${APP_BASE_URL}/admin-api/approvals`, { headers: apiHeaders(auth) });
        expect(queue.status(), `${account.role} was allowed to read the approval queue`).toBe(403);
        expect(((await queue.json()) as DecisionBody).error?.code).toBe("FORBIDDEN");
      } finally {
        await context.close();
      }
    }

    // The ticket survived every refusal untouched…
    const untouched = await fetchTicket(adminRequest, adminAuth, id);
    expect(untouched.status).toBe("pending");
    expect(untouched.decisions).toEqual([]);

    // …and the positive control: the operator tier IS enough, so the 403s above
    // are the role gate rather than a broken endpoint.
    const allowed = await decide(opARequest, opAAuth, id, "reject", "cleanup");
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  // ── (7) Self-approval ─────────────────────────────────────────────────────

  test("FINDING: nothing stops the requester from approving their own call", async () => {
    // The admin test-call endpoint runs the full proxy pipeline, so an operator
    // can file a ticket as themselves and then decide it as themselves. That is
    // exactly what happens below, and the source has no opinion about it: there
    // is no four-eyes check in `decideApproval` or in the route, and there
    // structurally cannot be one on the data plane either — a ticket's
    // `requestedBy` is a managed-KEY id (or null, as here) while `decided_by` is
    // an admin USERNAME, so the two identities are never comparable.
    //
    // The N-of-M threshold is the only separation-of-duty control the feature
    // has, and it counts distinct approvers, not approvers-other-than-the-
    // requester. On a 1-level tool a single principal can therefore authorise
    // its own high-risk call end to end. Asserted here as the behaviour that
    // ships, NOT as the behaviour that should ship.
    const fired = await opARequest.post(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${SELF.tool}/test`, {
      headers: apiHeaders(opAAuth),
      data: {},
    });
    expect(fired.status(), await fired.text()).toBe(200);
    const queued = (await fired.json()) as { isError?: boolean; content?: { text?: string }[] };
    expect(queued.isError).toBe(true);
    const match = PENDING_RESULT.exec(queued.content?.[0]?.text ?? "");
    if (!match) throw new Error(`admin test call was not queued: ${JSON.stringify(queued)}`);
    const id = Number(match[2]);

    // No caller token on the admin path, so the ticket records no requester at
    // all — the audit trail cannot even show that the approver was the asker.
    const ticket = await fetchTicket(adminRequest, adminAuth, id);
    expect(ticket.requestedBy).toBeNull();

    const selfApproved = await decide(opARequest, opAAuth, id, "approve", "approved by the requester");
    expect(selfApproved.status, JSON.stringify(selfApproved.body)).toBe(200);
    expect(selfApproved.body.status).toBe("approved");

    // …and the same operator then completes the call it asked for and blessed.
    const { value: completed, delta } = await withUpstreamDelta(adminRequest, SELF.path, async () => {
      const res = await opARequest.post(`${APP_BASE_URL}/admin-api/clients/${SERVER}/tools/${SELF.tool}/test`, {
        headers: apiHeaders(opAAuth),
        data: { __approval_id: id },
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()) as { isError?: boolean; content?: { text?: string }[] };
    });
    expect(completed.isError, `self-approved retry was refused: ${JSON.stringify(completed)}`).toBeFalsy();
    expect(delta, "the self-approved retry did not reach the upstream").toBe(1);
  });

  // ── (8) The decision is recorded ──────────────────────────────────────────

  test("approve and reject are written to the audit trail, attributed to the deciding user", async () => {
    // NOTE ON ORDER: this test reads back the rows the tests ABOVE wrote — it is
    // the only one here that isn't self-contained. That's sound under the suite's
    // execution model (workers: 1, fullyParallel: false, declaration order) and
    // it buys a real assertion no re-enacted flow would: the audit rows the
    // actual scenarios produced, not rows produced to be audited. Re-running
    // this test alone (`--grep`) will fail for that reason, and moving it above
    // tests 2/4/5 would too.
    //
    // Every decision above was made by OP_A or OP_B from their own sessions, so
    // a regression that stamped the row with a generic actor — or with whoever
    // set the fixtures up — shows here and nowhere else. Filtered by actor and
    // action rather than read positionally: this log is shared by the whole
    // suite and grows underneath us.
    const approvals = await auditRows(adminRequest, adminAuth, {
      actor: OP_A.username,
      action: "approval.approve",
      limit: "200",
    });
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((e) => e.actor === OP_A.username)).toBe(true);
    // `toolKey(clientName, toolName)` — the canonical `client__tool` target, not
    // the ticket id, so the log answers "what was authorised" rather than only
    // "which row changed".
    expect(approvals.some((e) => e.target === `${SERVER}__${GATED.tool}`)).toBe(true);

    // The multi-level detail is the interesting one: a partial approval is
    // audited too, carrying the running count and the threshold, so a reviewer
    // can see WHO supplied which of the required levels.
    const partial = approvals.find(
      (e) => e.target === `${SERVER}__${MULTI.tool}` && e.detail?.finalStatus === "pending",
    );
    expect(partial, "the first of two approvals was not audited").toBeTruthy();
    expect(partial?.detail?.approvalsReceived).toBe(1);
    expect(partial?.detail?.requiredLevels).toBe(REQUIRED_LEVELS);

    const closing = await auditRows(adminRequest, adminAuth, {
      actor: OP_B.username,
      action: "approval.approve",
      limit: "200",
    });
    expect(closing.some((e) => e.target === `${SERVER}__${MULTI.tool}` && e.detail?.finalStatus === "approved")).toBe(
      true,
    );

    const rejections = await auditRows(adminRequest, adminAuth, {
      actor: OP_A.username,
      action: "approval.reject",
      limit: "200",
    });
    expect(rejections.some((e) => e.target === `${SERVER}__${REJECTED.tool}`)).toBe(true);

    // Turning the requirement ON is itself an audited config change (the
    // `requiresApproval` tool mutation), attributed to the admin who did it in
    // beforeAll — so the log covers arming the gate, not just firing it.
    const armed = await auditRows(adminRequest, adminAuth, {
      actor: BOOTSTRAP_ADMIN_USERNAME,
      action: "tool.approval.enable",
      limit: "200",
    });
    expect(armed.some((e) => e.target === `${SERVER}__${GATED.tool}`)).toBe(true);
    expect(
      armed.some((e) => e.target === `${SERVER}__${MULTI.tool}` && e.detail?.approvalLevels === REQUIRED_LEVELS),
    ).toBe(true);
  });

  // ── (9) The operator-facing surface ───────────────────────────────────────

  test("the SPA lists the pending ticket and approving from the UI unblocks the data plane", async () => {
    const id = await fileTicket(UI.tool);

    await adminPage.goto("/admin/approvals");
    await expect(adminPage.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible();

    // The page lands on the Pending tab, so the fresh ticket must be there with
    // no filtering applied — this is the default view an on-call operator sees.
    const row = approvalRow(adminPage, id, UI.tool);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pending");

    // Act through the real confirm flow an operator uses, not a direct POST.
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    const [decision] = await Promise.all([
      adminPage.waitForResponse(
        (r) => r.url().includes(`/admin-api/approvals/${id}/approve`) && r.request().method() === "POST",
      ),
      adminPage.getByRole("button", { name: "Approve call" }).click(),
    ]);
    expect(decision.status(), `UI approve failed: ${await decision.text()}`).toBe(200);

    // The page reloads the active tab after deciding, so the SAME row locator
    // must now be absent from Pending and present under Approved, attributed to
    // the signed-in admin. Asserting both halves rules out a UI that merely
    // dropped the row from the list without the decision landing.
    await expect(row).toHaveCount(0);
    await adminPage.getByRole("tab", { name: "Approved" }).click();
    await expect(row).toBeVisible();
    await expect(row).toContainText(BOOTSTRAP_ADMIN_USERNAME);

    // Closing the loop: a decision made by a human clicking a button in the SPA
    // reaches the dispatch gate. Nothing short of an e2e can show this — the
    // path is browser -> admin API -> SQLite -> consumeApproval -> proxyToolCall.
    const { value: retry, delta } = await withUpstreamDelta(adminRequest, UI.path, () =>
      callTool(UI.tool, { __approval_id: id }),
    );
    expect(retry.isError, `retry after the UI approval was refused: ${retry.text}`).toBeFalsy();
    expect(delta, "the UI-approved retry did not reach the upstream").toBe(1);
  });
});
