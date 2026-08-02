/**
 * End-to-end test for OUTBOUND response sanitization — what the bridge strips
 * out of an upstream's reply before it reaches an MCP client.
 *
 * The sanitizer is `src/content-filtering/redaction.ts`, driven from the two
 * dispatchers that can reach a caller here:
 *   - `sanitizeRestResponse` in `src/proxy/dispatch-rest.ts`, called from BOTH
 *     the 2xx exit (processRestSuccessResponse) and the non-2xx exit, in the
 *     same fixed order: applyRedaction -> guardrail scan -> injected-credential
 *     strip -> context budget.
 *   - the equivalent block in `src/proxy/dispatch-mcp.ts` for MCP upstreams.
 * (`sanitizeToolDescription` in `src/content-filtering/sanitize.ts` is a
 * different, INBOUND thing — registration-time prompt-injection defence — and
 * is not what this spec covers.)
 *
 * What it actually redacts, precisely: `applyRedaction` walks the operator-
 * configured dot-paths for that tool (`tool_redactions`, set via
 * `PATCH /admin-api/clients/:name/tools/:tool` with `redactPaths`) and replaces
 * each matched LEAF with the literal marker `[REDACTED]`
 * (REDACTION_PLACEHOLDER). It is path-driven, not value-shape-driven and not
 * key-name-driven: nothing is redacted by default, and a credential-shaped
 * string at an unconfigured path reaches the caller verbatim. The one
 * unconditional strip is `stripInjectedCredentials`, which removes the
 * gateway's OWN injected upstream credential (marker `<redacted>`).
 *
 * The load-bearing test is the ERROR-path one: this repo has shipped
 * sanitization bypasses twice, and both times the happy path was covered while
 * a sibling exit (WS, then the REST non-2xx branch, then MCP-error parity) was
 * not. `src/proxy/__tests__/proxy-response-sanitization-parity.test.ts` pins
 * that at unit level; this pins it over the real wire, on both data-plane
 * surfaces.
 *
 * Deliberately NOT covered here, because the e2e stack can't reach them (they
 * stay covered by the unit parity suite above):
 *   - `stripInjectedCredentials` / the `<redacted>` marker. It only fires when
 *     the client has upstream auth configured, and `setUpstreamAuth` calls
 *     `encryptSecret`, which throws without SECRET_ENCRYPTION_KEY — unset in
 *     playwright.config.ts's webServer env, which this spec must not edit.
 *   - The guardrail response scan's spotlight envelope (`scanResponses` ->
 *     `UNTRUSTED`). Reaching it needs an upstream body matching an
 *     INJECTION_PATTERN, and none of the fixture's fixed bodies do; the fixture
 *     also strips unknown args (Ajv `removeAdditional: "all"`) so a caller
 *     can't route injection text through `echo` either.
 *   - The MCP-upstream dispatcher's sanitization (`dispatch-mcp.ts`). The only
 *     MCP upstream available to e2e is the bridge's own data plane, whose tools
 *     are already named `client__tool` — re-exposing them would need a name
 *     carrying the reserved `__` separator, which registration rejects.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL, FIXTURE_OPENAPI_EXTENDED_PATH } from "./support/env";
import { apiHeaders, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall } from "./support/mcp";

/** The marker `applyRedaction` writes in place of a matched leaf (REDACTION_PLACEHOLDER). */
const REDACTED = "[REDACTED]";

/** Redaction configured on its tools — the "an operator turned it on" client. */
const CLIENT_REDACTED = "e2e-sanitize-api";
/** No redaction on `get-secret` — the control, proving the default posture. */
const CLIENT_PLAIN = "e2e-sanitize-open-api";
/** Curated bundle over CLIENT_REDACTED's tools, for the /mcp-custom surface. */
const BUNDLE = "e2e-sanitize-bundle";

const SECRET_TOOL = "get-secret";
const ERROR_TOOL = "create-user";
const LIST_TOOL = "list-users";

/**
 * The exact body `GET /api/v1/secret` returns (e2e/support/fixture-server.ts is
 * the source of truth — these are mirrored here so an assertion failure names
 * the value it expected rather than a variable).
 */
const FIXTURE_SECRET = {
  note: "these should never reach an MCP client verbatim",
  apiKey: "sk-e2e-1234567890abcdefghijklmnopqrstuvwxyz",
  authorization: "Bearer e2e-upstream-token-abcdef0123456789",
  password: "e2e-hunter2-not-a-real-password",
} as const;

/**
 * The fixture has no `POST /api/v1/users` handler, so `create-user` gets a 404
 * carrying this body — the upstream content that the REST error exit embeds
 * into the caller-facing message, and therefore the thing the error path has to
 * sanitize. Standing in for a secret: the point is that the error envelope runs
 * the same pipeline as the success one, not what the leaked string happens to be.
 */
const FIXTURE_404_DETAIL = "not_found";

/** Shape of the ToolResult the admin per-tool test route returns verbatim. */
interface AdminToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

let page: Page;
let request: APIRequestContext;
let auth: AdminAuth;
let authHeader = "";

/** `PATCH /admin-api/clients/:name/tools/:tool` — the per-tool policy dispatcher. */
async function patchToolPolicy(clientName: string, toolName: string, body: Record<string, unknown>): Promise<void> {
  const res = await request.patch(`${APP_BASE_URL}/admin-api/clients/${clientName}/tools/${toolName}`, {
    headers: apiHeaders(auth),
    data: body,
  });
  expect(res.status(), `tool policy PATCH ${clientName}/${toolName} failed: ${await res.text()}`).toBe(200);
}

/**
 * One tools/call round trip on its own session. Each call establishes a fresh
 * session for the same reason mcp-protocol.spec.ts does: the Streamable HTTP
 * transport keeps per-session state, and sharing one across tests races with
 * the rest of the suite running serially in the same worker.
 *
 * The session is DELETEd afterwards on purpose. Sessions otherwise linger until
 * SESSION_TTL_MS (30 min) and the whole suite shares one MAX_SESSIONS budget of
 * 100 in a single long-lived server process, so a spec that opens a dozen and
 * never closes them taxes every spec that runs after it.
 */
async function callViaDataPlane(
  path: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string }> {
  const init = await initMcpSession(path, { authHeader, clientName: "e2e-sanitize" });
  try {
    const call = await mcpToolsCall(path, init.sessionId, toolName, authHeader, args);
    expect(call.status, `${path} -> ${toolName} returned no JSON-RPC envelope`).toBe(200);
    expect(call.text, `${path} -> ${toolName} carried no text content`).toBeDefined();
    return { isError: call.isError, text: call.text ?? "" };
  } finally {
    await fetch(`${APP_BASE_URL}${path}`, {
      method: "DELETE",
      headers: { "mcp-session-id": init.sessionId, authorization: authHeader },
    }).catch(() => undefined);
  }
}

/** Every configured path redacted, every raw credential gone, the rest intact. */
function expectSecretBodyRedacted(text: string): void {
  // Non-vacuous by construction: an unconfigured field proves the call really
  // reached the fixture, so the three absence assertions below can't pass just
  // because the whole call failed.
  expect(text).toContain(FIXTURE_SECRET.note);
  expect(text).toMatch(/"apiKey":\s*"\[REDACTED\]"/);
  expect(text).toMatch(/"authorization":\s*"\[REDACTED\]"/);
  expect(text).toMatch(/"password":\s*"\[REDACTED\]"/);
  expect(text).not.toContain(FIXTURE_SECRET.apiKey);
  expect(text).not.toContain(FIXTURE_SECRET.authorization);
  expect(text).not.toContain(FIXTURE_SECRET.password);
}

/** The REST non-2xx exit ran the same redaction the 2xx exit runs. */
function expectErrorBodyRedacted(result: { isError?: boolean; text: string }): void {
  expect(result.isError, "an upstream 404 must surface as an MCP isError result").toBe(true);
  // Proves we reached the upstream error branch and not some earlier gate
  // (breaker fail-fast, arg validation) that never sees an upstream body.
  expect(result.text).toContain("REST API returned 404");
  expect(result.text).toContain(REDACTED);
  expect(result.text).not.toContain(FIXTURE_404_DETAIL);
}

test.describe("outbound response sanitization", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Both clients discover the e2e-only extended OpenAPI doc — the one that
    // carries `get-secret`. Re-runs meet the DB the previous run left behind,
    // which registerViaApi tolerates (409).
    await registerViaApi(request, auth, CLIENT_REDACTED, FIXTURE_OPENAPI_EXTENDED_PATH);
    await registerViaApi(request, auth, CLIENT_PLAIN, FIXTURE_OPENAPI_EXTENDED_PATH);

    // The error-path tests deliberately provoke upstream failures, and the e2e
    // stack trips breakers on the SECOND one (CIRCUIT_BREAKER_FAILURE_THRESHOLD
    // = 2 in playwright.config.ts). Give this client headroom so a failing call
    // is always dispatched (and therefore always produces an upstream error
    // body to sanitize) rather than being short-circuited by an open breaker.
    const guards = await request.patch(`${APP_BASE_URL}/admin-api/clients/${CLIENT_REDACTED}`, {
      headers: apiHeaders(auth),
      data: { guards: { circuitBreaker: { failureThreshold: 50 } } },
    });
    expect(guards.status(), `client guards PATCH failed: ${await guards.text()}`).toBe(200);
    // Drops the cached breaker so the threshold above takes effect immediately
    // (registry.resetCircuitBreaker -> removeCircuitBreaker), and clears any
    // state a previous local run left on a reused server. 404 = not live yet.
    const reset = await request.post(`${APP_BASE_URL}/admin-api/clients/${CLIENT_REDACTED}/circuit-breaker/reset`, {
      headers: apiHeaders(auth),
    });
    expect([200, 404], `breaker reset failed: ${reset.status()}`).toContain(reset.status());

    // Redaction is opt-in per (client, tool) and keyed by RESPONSE DOT-PATH.
    // The three keys below are top-level leaves of the fixture's secret body.
    await patchToolPolicy(CLIENT_REDACTED, SECRET_TOOL, {
      redactPaths: ["apiKey", "authorization", "password"],
    });
    // Same policy applied to the 404-producing tool, so the error exit has
    // something configured to strip out of the upstream's error body.
    await patchToolPolicy(CLIENT_REDACTED, ERROR_TOOL, { redactPaths: ["error"] });

    // The control client keeps `get-secret` unconfigured (explicitly cleared so
    // a reused DB can't make the default-posture test lie), and uses a DIFFERENT
    // tool for the wildcard case — that keeps the two tests independent of the
    // order they run in.
    await patchToolPolicy(CLIENT_PLAIN, SECRET_TOOL, { redactPaths: [] });
    await patchToolPolicy(CLIENT_PLAIN, LIST_TOOL, { redactPaths: ["users.*.name"] });

    // Curated bundle over the redacted client's tools — the second data-plane
    // surface. Super-admin only; the bootstrap admin is teamless, so it passes.
    const bundleTools = [
      { client: CLIENT_REDACTED, tool: SECRET_TOOL },
      { client: CLIENT_REDACTED, tool: ERROR_TOOL },
    ];
    const created = await request.post(`${APP_BASE_URL}/admin-api/bundles`, {
      headers: apiHeaders(auth),
      data: { name: BUNDLE, description: "e2e response-sanitization surfaces", tools: bundleTools },
    });
    expect([201, 409], `bundle create(${BUNDLE}) failed: ${created.status()} ${await created.text()}`).toContain(
      created.status(),
    );
    if (created.status() === 409) {
      // Left behind by a previous local run — re-point it at this run's tools
      // rather than trusting whatever it happened to contain.
      const patched = await request.patch(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}`, {
        headers: apiHeaders(auth),
        data: { tools: bundleTools, enabled: true },
      });
      expect(patched.status(), `bundle patch(${BUNDLE}) failed: ${await patched.text()}`).toBe(200);
    }

    // Mint a key so the data plane is in a known auth-required state regardless
    // of which specs ran before this one.
    authHeader = (await mintMcpKey(request, auth, "e2e-sanitize")).authHeader;
  });

  test.afterAll(async () => {
    // Hand session slots back to the process-wide maxSessions budget.
    await closeTrackedMcpSessions();
    await page.close();
  });

  // ── (1) Happy path, client shard ──────────────────────────────────────────

  test("client shard: a 2xx body has every configured path replaced with the redaction marker", async () => {
    const result = await callViaDataPlane(`/mcp/${CLIENT_REDACTED}`, `${CLIENT_REDACTED}__${SECRET_TOOL}`);
    expect(result.isError, `get-secret failed: ${result.text}`).toBeFalsy();
    expectSecretBodyRedacted(result.text);
  });

  // ── (2) THE PARITY ASSERTION — the error exit runs the same pipeline ───────

  test("client shard: the REST non-2xx exit is sanitized too, not just the success exit", async () => {
    // The historical bypass: `REST API returned <status>: <body>` embedded the
    // upstream error body into the caller-facing message with no redaction and
    // no guardrail scan, so a debug 4xx echoing a secret walked straight past
    // the guarantee the 2xx path enforces.
    const result = await callViaDataPlane(`/mcp/${CLIENT_REDACTED}`, `${CLIENT_REDACTED}__${ERROR_TOOL}`, {
      name: "e2e-sanitize",
      email: "sanitize@example.com",
    });
    expectErrorBodyRedacted(result);
  });

  test("client shard: a validation error is generated by the bridge and echoes no upstream content", async () => {
    // The other reachable error class: Ajv rejects the args before the backend
    // is ever dialled, so this envelope is bridge-authored end to end. Asserted
    // so a future change that starts echoing upstream/argument content into it
    // has to come past this test.
    const result = await callViaDataPlane(`/mcp/${CLIENT_REDACTED}`, `${CLIENT_REDACTED}__${ERROR_TOOL}`, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Argument validation failed");
    expect(result.text).not.toContain(FIXTURE_SECRET.apiKey);
    expect(result.text).not.toContain(FIXTURE_404_DETAIL);
  });

  // ── (3) Both data-plane surfaces behave identically ───────────────────────

  test("bundle surface: /mcp-custom applies the same redaction as /mcp/:clientName", async () => {
    // Guards/breakers/sanitizing are documented to behave identically no matter
    // which narrowing filter a call arrived through; the bundle endpoint is a
    // separate mount (mountMcpScope in src/mcp/transports.ts), so "the shard
    // works" is not evidence that this one does.
    const result = await callViaDataPlane(`/mcp-custom/${BUNDLE}`, `${CLIENT_REDACTED}__${SECRET_TOOL}`);
    expect(result.isError, `bundle get-secret failed: ${result.text}`).toBeFalsy();
    expectSecretBodyRedacted(result.text);
  });

  test("bundle surface: the error exit is sanitized there too", async () => {
    const result = await callViaDataPlane(`/mcp-custom/${BUNDLE}`, `${CLIENT_REDACTED}__${ERROR_TOOL}`, {
      name: "e2e-sanitize",
      email: "sanitize@example.com",
    });
    expectErrorBodyRedacted(result);
  });

  // ── (4) Admin-facing surface ──────────────────────────────────────────────

  test("admin surface: the per-tool test call is redacted identically — admins get no unredacted view", async () => {
    // POST /admin-api/clients/:name/tools/:tool/test runs the LIVE proxy
    // pipeline (proxyToolCall) and returns its ToolResult verbatim, so the
    // design gives an authenticated operator exactly what a proxied MCP client
    // sees. This test asserts that documented behaviour rather than assuming
    // either direction.
    const res = await request.post(`${APP_BASE_URL}/admin-api/clients/${CLIENT_REDACTED}/tools/${SECRET_TOOL}/test`, {
      headers: apiHeaders(auth),
      data: {},
    });
    expect(res.status(), `admin tool test failed: ${await res.text()}`).toBe(200);
    const body = (await res.json()) as AdminToolResult;
    expect(body.isError).toBeFalsy();
    const text = (body.content ?? []).map((c) => c.text ?? "").join("\n");
    expectSecretBodyRedacted(text);
  });

  // ── (5) The configurable surface: default posture + an extra path ──────────

  test("default posture: nothing is redacted until an operator configures a path", async () => {
    // Deliberately asserting the design as written, NOT as one might wish it
    // were: redaction is path-driven and opt-in per tool, so an upstream that
    // returns credential-shaped values at unconfigured paths leaks them
    // verbatim. If this test ever starts failing because the bridge grew a
    // default deny-list, that is a behaviour change worth noticing here.
    const result = await callViaDataPlane(`/mcp/${CLIENT_PLAIN}`, `${CLIENT_PLAIN}__${SECRET_TOOL}`);
    expect(result.isError, `get-secret failed: ${result.text}`).toBeFalsy();
    expect(result.text).toContain(FIXTURE_SECRET.apiKey);
    expect(result.text).toContain(FIXTURE_SECRET.authorization);
    expect(result.text).toContain(FIXTURE_SECRET.password);
    expect(result.text).not.toContain(REDACTED);
  });

  test("a configured wildcard path redacts every matching leaf and nothing else", async () => {
    // `users.*.name` exercises the `*` segment of redactInPlace over an array,
    // and the surviving `id` leaves prove the redaction is selective rather
    // than blanket.
    const result = await callViaDataPlane(`/mcp/${CLIENT_PLAIN}`, `${CLIENT_PLAIN}__${LIST_TOOL}`);
    expect(result.isError, `list-users failed: ${result.text}`).toBeFalsy();
    expect(result.text).toContain(REDACTED);
    expect(result.text).not.toContain("Ada Lovelace");
    expect(result.text).not.toContain("Grace Hopper");
    expect(result.text).toMatch(/"id":\s*1/);
    expect(result.text).toMatch(/"id":\s*2/);
  });
});
