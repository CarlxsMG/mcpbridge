/**
 * End-to-end test that a per-tool guard saved through the admin API is actually
 * ENFORCED on a live MCP call — the half of the guard story `guard-persist`
 * doesn't tell.
 *
 * `guard-persist.spec.ts` proves a guard VALUE survives the round trip (form ->
 * PATCH -> SQLite -> reload). Nothing in the suite proved a saved guard ever
 * REFUSES anything. This closes that loop over the wire: admin API -> SQLite ->
 * live registry -> `proxyToolCall` (src/proxy/proxy.ts), which is where every
 * policy is enforced. It has to be enforced *there* and nowhere else: MCP
 * multiplexes every tool over the single `POST /mcp/:clientName` route, so the
 * bridge only learns WHICH tool is being called once the JSON-RPC body is
 * parsed — an Express middleware could never see it. Backend unit tests call
 * `proxyToolCall()` directly with a hand-built registry; only an e2e can show
 * that the value an operator typed into the admin API reaches that function at
 * all.
 *
 * Every refusal asserted below is the literal string its gate emits
 * (src/proxy/gates.ts, src/proxy/dispatch-rest.ts), returned as an `isError`
 * result inside a 200 JSON-RPC envelope — never a transport error, so an agent
 * that trips a guard can recover instead of losing its session.
 *
 * Each scenario gets its OWN registered client, which looks wasteful and isn't:
 * the per-tool rate limit is a 60-second SLIDING window keyed on
 * `clientName__toolName` (src/middleware/rate-limiter.ts, WINDOW_MS). Once a
 * test has spent a tool's budget there is no way to hand it back inside the 30s
 * test timeout, so no two tests may share a rate-limited tool — and a test that
 * needs a *successful* call can never reuse one either.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import { apiHeaders, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall, parseSseJson, type McpCallResult } from "./support/mcp";

// ── Fixtures under test ──────────────────────────────────────────────────────

/** One client per scenario — see the header note on the un-resettable window. */
const RATE_SERVER = "e2e-guard-enf-rate-api";
const SCOPE_SERVER = "e2e-guard-enf-scope-api";
const DISABLED_SERVER = "e2e-guard-enf-disabled-api";
const TIMEOUT_SERVER = "e2e-guard-enf-timeout-api";
const RESET_SERVER = "e2e-guard-enf-reset-api";
const SERVERS = [RATE_SERVER, SCOPE_SERVER, DISABLED_SERVER, TIMEOUT_SERVER, RESET_SERVER];

/**
 * All five register against the e2e-only EXTENDED OpenAPI doc (support/
 * openapi-extended.ts) rather than the shared fixture: only that document
 * declares `slow`, the endpoint the timeout scenario needs.
 */
const OPENAPI_PATH = FIXTURE_OPENAPI_EXTENDED_PATH;

/**
 * `checkToolRateLimitGate`'s refusal (src/proxy/gates.ts). Asserted as a full
 * shape rather than a substring so a regression that drops the retry-after hint
 * — the only actionable part of the message for a caller — fails here too.
 */
const RATE_LIMIT_REFUSAL = /^Tool rate limit exceeded — retry after \d+s$/;

/**
 * How long the fixture's `slow` tool sleeps, and the guard set under it.
 * Both are deliberately small: the sleep must stay far below Playwright's 30s
 * test timeout, since a GET is idempotent and the bridge retries it
 * RETRY_MAX_ATTEMPTS (2) more times with exponential backoff before giving up.
 */
const SLOW_MS = 1200;
const TIMEOUT_GUARD_MS = 300;

/** Bearer for the data plane, minted once in beforeAll. */
let authHeader: string;

// ── Local helpers (this spec owns them — e2e/support/* belongs to other specs) ─

/** An open Streamable-HTTP session against one client's data-plane endpoint. */
interface DataPlaneSession {
  clientName: string;
  path: string;
  sessionId: string;
}

/**
 * PATCH one tool's admin state. Every scenario below SETS what it depends on
 * instead of assuming a default: `reuseExistingServer` means a local re-run
 * meets the database the previous run left behind, guards and all.
 */
async function patchTool(
  request: APIRequestContext,
  auth: AdminAuth,
  clientName: string,
  toolName: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${clientName}/tools/${toolName}`, {
    headers: apiHeaders(auth),
    data: body,
  });
  expect(res.status(), `PATCH ${clientName}/${toolName} ${JSON.stringify(body)} failed: ${await res.text()}`).toBe(200);
}

async function openSession(clientName: string): Promise<DataPlaneSession> {
  const path = `/mcp/${clientName}`;
  const { sessionId } = await initMcpSession(path, { authHeader, clientName: "e2e-guard-enf" });
  return { clientName, path, sessionId };
}

/**
 * Hand the session slot back. The gateway caps concurrent sessions
 * (config.maxSessions, 100) and only expires idle ones after SESSION_TTL_MS
 * (30 min), so a suite-wide habit of abandoning sessions would eventually 503
 * whichever spec happens to run last.
 */
async function closeSession(session: DataPlaneSession): Promise<void> {
  await fetch(`${APP_BASE_URL}${session.path}`, {
    method: "DELETE",
    headers: { "mcp-session-id": session.sessionId, authorization: authHeader },
  });
}

/** tools/call for one of the session's own tools, addressed as `client__tool`. */
async function callTool(
  session: DataPlaneSession,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<McpCallResult> {
  return mcpToolsCall(session.path, session.sessionId, `${session.clientName}__${toolName}`, authHeader, args);
}

/** The tool names this session is currently advertised, via a raw tools/list. */
async function listToolNames(session: DataPlaneSession): Promise<string[]> {
  const res = await fetch(`${APP_BASE_URL}${session.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": session.sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 20, params: {} }),
  });
  expect(res.status).toBe(200);
  const parsed = parseSseJson(await res.text());
  const tools = (parsed.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  return tools.map((t) => t.name);
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test.describe("per-tool guards are enforced at dispatch", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Mint a key so the data plane is in a known auth-required state regardless
    // of which spec ran first (see mintMcpKey's note on that transition).
    authHeader = (await mintMcpKey(request, auth, "e2e-guard-enf")).authHeader;

    // Registration goes through the API, not the register form: this spec is
    // about what happens AFTER a backend exists, and smoke.spec.ts already
    // covers the UI discovery path.
    for (const name of SERVERS) {
      await registerViaApi(request, auth, name, OPENAPI_PATH);
    }
  });

  test.afterAll(async () => {
    // Hand session slots back to the process-wide maxSessions budget.
    await closeTrackedMcpSessions();
    await page.close();
  });

  test("a rate-limit guard refuses the second call inside the window", async () => {
    await patchTool(request, auth, RATE_SERVER, "list-users", { guards: { rateLimitPerMin: 1 } });

    const session = await openSession(RATE_SERVER);
    try {
      const first = await callTool(session, "list-users");
      expect(first.status).toBe(200);
      expect(
        first.isError,
        `the first call was refused (${first.text}) — if this is a rate-limit refusal, a previous run of ` +
          `this spec within the last 60s left tokens in this tool's sliding window; re-run in a minute`,
      ).toBeFalsy();
      // Proves the budget was spent on a call that really reached the fixture,
      // not on something the pipeline short-circuited earlier.
      expect(first.text).toContain("Ada Lovelace");

      const second = await callTool(session, "list-users");
      // A tripped guard is an MCP-level error, not a 429: the transport stays
      // healthy and the session survives, so the caller can back off and retry.
      expect(second.status).toBe(200);
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(RATE_LIMIT_REFUSAL);
      expect(second.text).not.toContain("Ada Lovelace");
    } finally {
      await closeSession(session);
    }
  });

  test("the rate-limit budget is per tool, not per client", async () => {
    // The bucket key is the composite `clientName__toolName`, so exhausting one
    // tool must leave its siblings untouched. A regression that keyed the bucket
    // on the client alone would take a whole backend offline the moment any one
    // of its tools got busy — and would still pass a single-tool test.
    await patchTool(request, auth, SCOPE_SERVER, "list-users", { guards: { rateLimitPerMin: 1 } });
    await patchTool(request, auth, SCOPE_SERVER, "echo", { guards: null });

    const session = await openSession(SCOPE_SERVER);
    try {
      const limitedFirst = await callTool(session, "list-users");
      expect(limitedFirst.isError, `first call to the limited tool was refused: ${limitedFirst.text}`).toBeFalsy();
      const limitedSecond = await callTool(session, "list-users");
      expect(limitedSecond.isError).toBe(true);
      expect(limitedSecond.text).toMatch(RATE_LIMIT_REFUSAL);

      // Same client, same session, same 60s window — different tool.
      const sibling = await callTool(session, "echo");
      expect(sibling.status).toBe(200);
      expect(sibling.isError, `sibling tool was refused: ${sibling.text}`).toBeFalsy();
      // /api/v1/echo reflects what the bridge sent upstream, so a real round
      // trip to the fixture is visible in the payload.
      expect(sibling.text).toContain("host");
    } finally {
      await closeSession(session);
    }
  });

  test("disabling a tool hides it from tools/list and blocks a direct call", async () => {
    await patchTool(request, auth, DISABLED_SERVER, "get-secret", { enabled: false });

    const session = await openSession(DISABLED_SERVER);
    try {
      const advertised = await listToolNames(session);
      expect(advertised).not.toContain(`${DISABLED_SERVER}__get-secret`);
      // Per-tool flag, not a client-wide kill switch: the siblings stay served.
      expect(advertised).toContain(`${DISABLED_SERVER}__list-users`);

      // Hiding the name is not enough — a client holding a stale tool list can
      // still address it, so proxyToolCall keeps its own availability backstop
      // (checkClientToolAvailable, src/proxy/gates.ts).
      const call = await callTool(session, "get-secret");
      expect(call.status).toBe(200);
      expect(call.isError).toBe(true);
      expect(call.text).toBe(`Tool '${DISABLED_SERVER}__get-secret' is disabled`);
    } finally {
      await closeSession(session);
    }

    // Re-enable: a disable an operator can't undo is a footgun, and the flag is
    // durable, so leaving it off would hand the next local run a broken client.
    await patchTool(request, auth, DISABLED_SERVER, "get-secret", { enabled: true });
    const reopened = await openSession(DISABLED_SERVER);
    try {
      expect(await listToolNames(reopened)).toContain(`${DISABLED_SERVER}__get-secret`);
    } finally {
      await closeSession(reopened);
    }
  });

  test("a timeout guard aborts a call the backend would otherwise have answered", async () => {
    // Clear first: the baseline below only means something with no guard in
    // place, and a re-run inherits whatever the previous run left here.
    await patchTool(request, auth, TIMEOUT_SERVER, "slow", { guards: null });

    const session = await openSession(TIMEOUT_SERVER);
    try {
      // A/B against an identical call: same tool, same sleep, only the guard
      // differs. Unguarded, the global TOOL_CALL_TIMEOUT_MS (30s) is far above
      // the fixture's sleep, so the call completes normally.
      const baseline = await callTool(session, "slow", { ms: SLOW_MS });
      expect(baseline.status).toBe(200);
      expect(baseline.isError, `unguarded slow call failed: ${baseline.text}`).toBeFalsy();
      expect(baseline.text).toContain("sleptMs");

      await patchTool(request, auth, TIMEOUT_SERVER, "slow", { guards: { timeoutMs: TIMEOUT_GUARD_MS } });

      const guarded = await callTool(session, "slow", { ms: SLOW_MS });
      expect(guarded.status).toBe(200);
      expect(guarded.isError).toBe(true);
      // The guard becomes the per-attempt AbortSignal.timeout in dispatch-rest.ts,
      // so an expired call leaves through the network-failure exit carrying the
      // last attempt's abort reason — it is NOT a distinct "timeout" message.
      expect(guarded.text).toContain(`Failed to reach ${TIMEOUT_SERVER}:`);
      expect(guarded.text).toMatch(/timed out|abort/i);
    } finally {
      // Session first: a leaked session holds one of the 100 slots until the
      // 30-minute TTL, whereas a leaked guard is self-healing (this test clears
      // it again on the way in).
      await closeSession(session);
      await patchTool(request, auth, TIMEOUT_SERVER, "slow", { guards: null });
    }
  });

  test("clearing a guard restores access, even with the window still exhausted", async () => {
    // Guards must be reversible from the admin API alone. "Clear the field"
    // regressions are easy to ship — the write path only ever gets exercised
    // with a value — and they leave an operator with a tool they cannot unblock.
    await patchTool(request, auth, RESET_SERVER, "list-users", { guards: { rateLimitPerMin: 1 } });

    const session = await openSession(RESET_SERVER);
    try {
      const allowed = await callTool(session, "list-users");
      expect(allowed.isError, `first call was refused: ${allowed.text}`).toBeFalsy();
      const refused = await callTool(session, "list-users");
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(RATE_LIMIT_REFUSAL);

      // `guards: null` is the clear (validateToolGuardInput rejects 0 and null
      // for rateLimitPerMin itself — the whole guard object is what gets
      // dropped), which deletes the tool_guards row.
      await patchTool(request, auth, RESET_SERVER, "list-users", { guards: null });

      // The sliding window is still full — the same two calls are still inside
      // it — so this only passes because the gate is skipped outright rather
      // than consulting a stale bucket.
      const restored = await callTool(session, "list-users");
      expect(restored.status).toBe(200);
      expect(restored.isError, `call still refused after clearing the guard: ${restored.text}`).toBeFalsy();
      expect(restored.text).toContain("Ada Lovelace");
    } finally {
      await closeSession(session);
    }
  });
});
