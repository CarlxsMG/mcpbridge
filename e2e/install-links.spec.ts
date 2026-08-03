/**
 * End-to-end test for shareable bundle install links — the admin-side mint /
 * list / revoke routes under `/admin-api/bundles/:name/install-links` and the
 * public, unauthenticated `GET /install/:token` that redeems them.
 *
 * The feature's promise is narrow and entirely about a non-technical teammate:
 * paste a link, get a connection config, be connected. Nobody logs into the
 * admin UI, so the link has to carry a real bearer credential — and
 * bundle-install-links.ts is explicit about what makes that safe (see its
 * header): the embedded key is minted at link-creation time, "scoped ONLY to
 * this bundle's tools", and "revoked the moment this link is revoked".
 *
 * What this proves that src/routes/__tests__/routes-bundle-install-links.test.ts
 * doesn't:
 *
 *   - The config is USABLE, not merely well-formed. That unit test asserts the
 *     snippet contains an `mcp_`-prefixed string; it never connects with it.
 *     Here the URL and the Authorization header are pulled back out of the
 *     generated snippet and driven through a real initialize + tools/call
 *     against the live gateway, asserting the fixture upstream's own payload
 *     ("Ada Lovelace") comes back. A link that hands out plausible JSON nobody
 *     can connect with is exactly the failure that slips past shape assertions.
 *
 *   - The scope claim is enforced at DISPATCH, not just written into a row.
 *     Key confinement lives in proxyToolCall's checkKeyScopeGate
 *     (src/proxy/gates.ts), several layers below the route the unit test pokes.
 *     Note the granularity the source actually gives you, which the tests below
 *     pin precisely: the key is scoped to the bundle's `client__tool` pairs, so
 *     it is refused on another bundle's tool AND on a sibling tool of the very
 *     same client — but it is not confined to the `/mcp-custom/:bundle` URL, and
 *     the in-scope tool answers on the client shard too. Scoped by tool, not by
 *     endpoint.
 *
 *   - Revocation kills the CREDENTIAL, not just the link. Re-redeeming a
 *     revoked token 404ing is the easy half; the half that matters is that the
 *     key someone already copied into their editor stops authenticating. That
 *     is asserted on the wire (403 from mcpAuth), not by reading a DB column.
 *
 * ── This spec depends on a configured secrets provider ──────────────────────
 * Minting a link requires one: createInstallLink() encrypts the provisioned
 * key's raw secret at rest so the snippet can be rebuilt on every visit, and
 * refuses with 501 SECRET_BOX_NOT_CONFIGURED when `SECRET_ENCRYPTION_KEY` is
 * unset. playwright.config.ts's `webServer.env` sets it; `beforeAll` mints once
 * and ASSERTS the 201, so a removed key fails immediately with a message naming
 * it rather than turning every test below into an unexplained 501.
 *
 * That check is an assertion and not a skip guard on purpose — an earlier draft
 * skipped the link-dependent tests whenever the probe came back 501, which made
 * a broken mint indistinguishable from an unconfigured stack and reported both
 * as a green run with four skips.
 *
 * ── Rate-limit budget ───────────────────────────────────────────────────────
 * `GET /install/:token` is public, so it is per-IP rate limited at
 * `config.rateLimitInstallLink` (default 20/min) and playwright.config.ts does
 * NOT raise it the way it raises the login/register/MCP limits. The whole suite
 * shares one IP, and this is the only spec that touches the route. It spends 8
 * redemptions; keep new ones well under the cap, or a re-run inside the same
 * minute starts answering 429 — which looks nothing like the bug it would be
 * interrupting.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import { apiHeaders, createAdminUser, loginAs, mintMcpKey, registerViaApi, type AdminAuth } from "./support/admin";
import { closeTrackedMcpSessions, initMcpSession, mcpToolsCall, parseSseJson } from "./support/mcp";

/** Two servers so the "scoped to another bundle's tools" probe is genuinely cross-client. */
const SERVER_A = "e2e-install-alpha-api";
const SERVER_B = "e2e-install-beta-api";

/** Both fixture servers expose these; `list-users` is the one the bundle curates. */
const TOOL = "list-users";
const SIBLING_TOOL = "create-user";

const BUNDLE = "e2e-install-bundle";
const OTHER_BUNDLE = "e2e-install-other-bundle";
const EMPTY_BUNDLE = "e2e-install-empty-bundle";
const MISSING_BUNDLE = "e2e-install-no-such-bundle";

const BUNDLE_PLANE = `/mcp-custom/${BUNDLE}`;
const OTHER_PLANE = `/mcp-custom/${OTHER_BUNDLE}`;

const IN_BUNDLE = `${SERVER_A}__${TOOL}`;
const IN_BUNDLE_SIBLING = `${SERVER_A}__${SIBLING_TOOL}`;
const OTHER_BUNDLE_TOOL = `${SERVER_B}__${TOOL}`;

/** The gateway's own discovery meta-tool, appended by mcp-server.ts to every non-empty tools/list. */
const SEARCH_TOOL = "search_tools";

/** What the bridge sees as this spec's client identity in `initialize`. */
const CLIENT_LABEL = "e2e-install-links";

/** A non-admin account, for the role gate on minting. Password >= 12 chars (user-create rule). */
const OPERATOR_USERNAME = "e2e-install-operator";
const OPERATOR_PASSWORD = "e2e-install-operator-pw-2026";

/** POST /admin-api/bundles/:name/install-links — `token` appears in this response and never again. */
interface InstallLinkRecord {
  id: number;
  bundleName: string;
  tokenPrefix: string;
  token: string;
  mcpKeyId: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** GET /install/:token, 200 branch. */
interface RedeemedInstall {
  bundle: {
    name: string;
    description: string | null;
    tools: { client: string; tool: string; description: string }[];
  };
  connect: { filename: string; snippet: string; instructions: string[] };
}

/** The generic-json connect template's shape (src/cli/connect-templates.ts). */
interface ConnectServerEntry {
  url?: string;
  transport?: string;
  headers?: Record<string, string | undefined>;
}

interface ConnectSnippet {
  mcpServers?: Record<string, ConnectServerEntry | undefined>;
}

interface RawResponse {
  status: number;
  body: string;
}

// ── Local helpers (this file only — e2e/support/* is shared and off limits) ──

async function mintInstallLink(
  request: APIRequestContext,
  auth: AdminAuth,
  bundleName: string,
  expiresAt: number | null = null,
): Promise<RawResponse> {
  const res = await request.post(`${APP_BASE_URL}/admin-api/bundles/${bundleName}/install-links`, {
    headers: apiHeaders(auth),
    data: { expiresAt },
  });
  return { status: res.status(), body: await res.text() };
}

/** Mint and assert the 201, returning the parsed record (raw token included). */
async function mintInstallLinkOk(
  request: APIRequestContext,
  auth: AdminAuth,
  bundleName: string,
  expiresAt: number | null = null,
): Promise<InstallLinkRecord> {
  const res = await mintInstallLink(request, auth, bundleName, expiresAt);
  expect(res.status, `install-link mint failed: ${res.body}`).toBe(201);
  return JSON.parse(res.body) as InstallLinkRecord;
}

async function revokeInstallLink(
  request: APIRequestContext,
  auth: AdminAuth,
  bundleName: string,
  id: number,
): Promise<RawResponse> {
  const res = await request.delete(`${APP_BASE_URL}/admin-api/bundles/${bundleName}/install-links/${id}`, {
    headers: apiHeaders(auth),
  });
  return { status: res.status(), body: await res.text() };
}

/**
 * Redeem a token the way a teammate does: a bare `fetch`, with no cookie jar,
 * no CSRF token and no Authorization header. Deliberately NOT Playwright's
 * `request` context, which shares the browser context's cookies and would
 * silently carry the admin session — the route being genuinely unauthenticated
 * is half of what makes this feature worth testing.
 */
async function redeemInstallLink(token: string): Promise<RawResponse & { setCookie: string | null }> {
  const res = await fetch(`${APP_BASE_URL}/install/${token}`);
  return { status: res.status, body: await res.text(), setCookie: res.headers.get("set-cookie") };
}

/** The `{ code, message }` pair from the standard error envelope, minus the per-request `request_id`. */
function errorOf(body: string): { code?: string; message?: string } {
  const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
  return { code: parsed.error?.code, message: parsed.error?.message };
}

/**
 * Pull a live connection out of the generated snippet — the same two values a
 * human copies into their MCP client. The gateway URL is validated to point
 * back at this gateway and reduced to a path, because the shared MCP helpers
 * take a path and prepend APP_BASE_URL.
 */
function connectionFrom(redeemed: RedeemedInstall, bundleName: string): { path: string; authHeader: string } {
  const parsed = JSON.parse(redeemed.connect.snippet) as ConnectSnippet;
  const entry = parsed.mcpServers?.[bundleName];
  const url = entry?.url;
  const authHeader = entry?.headers?.Authorization;
  if (typeof url !== "string" || typeof authHeader !== "string") {
    throw new Error(`connect snippet has no usable "${bundleName}" entry: ${redeemed.connect.snippet}`);
  }
  expect(entry?.transport, "every endpoint this gateway exposes is Streamable HTTP").toBe("streamable-http");
  const gatewayUrl = new URL(url);
  expect(gatewayUrl.origin, "the snippet must point back at this gateway").toBe(APP_BASE_URL);
  return { path: gatewayUrl.pathname, authHeader };
}

/**
 * A sessionless `initialize` POST kept raw. `initMcpSession` throws on any
 * non-200, which is the exact case the revoked-key assertion needs to inspect.
 */
async function rawInitialize(path: string, authHeader: string): Promise<RawResponse> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
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
        clientInfo: { name: CLIENT_LABEL, version: "1.0" },
      },
    }),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * The advertised tool names on an established session, minus `search_tools` —
 * the gateway's own meta-tool is not curated content, so it is set aside rather
 * than baked into every expected list.
 */
async function toolNamesOn(path: string, sessionId: string, authHeader: string): Promise<string[]> {
  const res = await fetch(`${APP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      authorization: authHeader,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }),
  });
  expect(res.status).toBe(200);
  const parsed = parseSseJson(await res.text());
  const tools = (parsed.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  return tools
    .map((t) => t.name)
    .filter((name) => name !== SEARCH_TOOL)
    .sort();
}

/**
 * Replace a bundle outright. Unlike `registerViaApi`'s tolerated 409, a leftover
 * bundle from a previous local run (playwright.config.ts reuses the server
 * outside CI) could carry different membership, which would quietly change what
 * the minted key is scoped to. Deleting first also revokes that run's leftover
 * install links and their keys — the bundle-delete path calls
 * revokeAllInstallLinksForBundle — so no stale credential survives into this one.
 */
async function recreateBundle(
  request: APIRequestContext,
  auth: AdminAuth,
  name: string,
  tools: { client: string; tool: string }[],
): Promise<void> {
  const dropped = await request.delete(`${APP_BASE_URL}/admin-api/bundles/${name}`, { headers: apiHeaders(auth) });
  expect([200, 404], `bundle cleanup failed: ${dropped.status()}`).toContain(dropped.status());
  const created = await request.post(`${APP_BASE_URL}/admin-api/bundles`, {
    headers: apiHeaders(auth),
    data: { name, description: `e2e install-link bundle (${name})`, tools },
  });
  expect(created.status(), `bundle create failed: ${await created.text()}`).toBe(201);
}

test.describe("Bundle install links — mint, redeem, revoke", () => {
  let page: Page;
  let request: APIRequestContext;
  let auth: AdminAuth;

  /** A plain, unrestricted managed key — the positive control for every scope refusal below. */
  let unscopedHeader: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    auth = await loginAs(page);

    // Both point at the same fixture upstream; only the registered name differs,
    // which is all the cross-client scope probe needs.
    await registerViaApi(request, auth, SERVER_A);
    await registerViaApi(request, auth, SERVER_B);

    // The data plane is fail-closed as soon as any managed key exists, and by
    // the time this file runs an earlier spec has certainly minted one. Mint our
    // own unrestricted key so the control never depends on which.
    ({ authHeader: unscopedHeader } = await mintMcpKey(request, auth, "e2e-install-control"));

    await recreateBundle(request, auth, BUNDLE, [{ client: SERVER_A, tool: TOOL }]);
    await recreateBundle(request, auth, OTHER_BUNDLE, [{ client: SERVER_B, tool: TOOL }]);
    await recreateBundle(request, auth, EMPTY_BUNDLE, []);

    await createAdminUser(request, auth, {
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      role: "operator",
    });

    // Mint once up front to fail fast, and with a message naming the cause:
    // nothing exposes "is the secret box configured" over HTTP, so a missing
    // SECRET_ENCRYPTION_KEY would otherwise surface as an unexplained 501 in
    // every test below. Asserted rather than branched on — an earlier draft
    // skipped the link-dependent tests whenever this came back 501, which made
    // a BROKEN mint indistinguishable from an unconfigured one and reported
    // both as a green run with four skips.
    //
    // Revoked immediately so the probe never leaves a live shared credential
    // behind for the rest of the run; the tests below each mint their own.
    const probe = await mintInstallLink(request, auth, BUNDLE);
    expect(
      probe.status,
      `minting an install link failed (${probe.status}: ${probe.body}) — a 501 SECRET_BOX_NOT_CONFIGURED ` +
        "means SECRET_ENCRYPTION_KEY is missing from playwright.config.ts's webServer.env",
    ).toBe(201);
    const record = JSON.parse(probe.body) as InstallLinkRecord;
    const revoked = await revokeInstallLink(request, auth, BUNDLE, record.id);
    expect(revoked.status).toBe(200);
  });

  test.afterAll(async () => {
    // Hand session slots back to the process-wide maxSessions budget.
    await closeTrackedMcpSessions();
    await page.close();
  });

  // The other branch — minting refused with 501 SECRET_BOX_NOT_CONFIGURED when
  // no secrets provider is configured — is deliberately NOT a test here. It
  // cannot run: playwright.config.ts sets SECRET_ENCRYPTION_KEY for the whole
  // suite, so a test guarded on the absence of one would be permanently skipped,
  // which reads as "conditionally covered" while covering nothing. That contract
  // is pinned by four backend suites instead, one of them mutation-killing:
  // admin/tool-composition/__tests__/bundle-install-links-mutation.test.ts and
  // routes/__tests__/routes-bundle-install-links.test.ts.

  test("a redeemed link hands out a config that actually connects to the bundle", async () => {
    const record = await mintInstallLinkOk(request, auth, BUNDLE);
    expect(record.bundleName).toBe(BUNDLE);
    expect(record.token.startsWith("bil_")).toBe(true);
    expect(record.tokenPrefix).toBe(record.token.slice(0, 12));
    expect(record.revokedAt).toBeNull();
    expect(typeof record.mcpKeyId).toBe("number");

    // Show-once: the raw token is never retrievable again, only its prefix.
    const listed = await request.get(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}/install-links`, {
      headers: apiHeaders(auth),
    });
    expect(listed.status()).toBe(200);
    expect(await listed.text()).not.toContain(record.token);

    const redeemed = await redeemInstallLink(record.token);
    expect(redeemed.status, `redeem failed: ${redeemed.body}`).toBe(200);
    // Public route: it must not try to establish any browser state.
    expect(redeemed.setCookie).toBeNull();

    const body = JSON.parse(redeemed.body) as RedeemedInstall;
    expect(body.bundle.name).toBe(BUNDLE);
    expect(body.bundle.tools.map((t) => `${t.client}__${t.tool}`)).toEqual([IN_BUNDLE]);
    // The description is joined in from the LIVE registry rather than stored on
    // the bundle, so a non-empty string here also proves the curated tool is
    // really registered and discoverable at redeem time.
    expect(body.bundle.tools[0].description).toMatch(/\S/);

    // The snippet must be paste-ready: a real key, not the placeholder every
    // other caller of generateConnectSnippet is contractually required to pass.
    expect(body.connect.snippet).not.toContain("YOUR_MCP_API_KEY");
    expect(body.connect.snippet).toContain("mcp_");
    // …and never the admin credential that minted it.
    expect(body.connect.snippet).not.toContain(auth.csrf);

    // The assertion this whole test exists for: connect with exactly what the
    // link handed out and reach the upstream through it.
    const conn = connectionFrom(body, BUNDLE);
    expect(conn.path).toBe(BUNDLE_PLANE);
    expect(conn.authHeader.startsWith("Bearer mcp_")).toBe(true);

    const init = await initMcpSession(conn.path, { authHeader: conn.authHeader, clientName: CLIENT_LABEL });
    expect(await toolNamesOn(conn.path, init.sessionId, conn.authHeader)).toEqual([IN_BUNDLE]);

    const call = await mcpToolsCall(conn.path, init.sessionId, IN_BUNDLE, conn.authHeader);
    expect(call.status).toBe(200);
    expect(call.isError).toBeFalsy();
    expect(call.text).toContain("Ada Lovelace");
  });

  test("the minted key is scoped to that bundle's tools — and to nothing else", async () => {
    const record = await mintInstallLinkOk(request, auth, BUNDLE);
    const redeemed = await redeemInstallLink(record.token);
    expect(redeemed.status).toBe(200);
    const { authHeader } = connectionFrom(JSON.parse(redeemed.body) as RedeemedInstall, BUNDLE);

    // Positive control first: the other bundle's tool is live and dispatches
    // for an unrestricted key. Without this, the refusal below could just as
    // easily be a broken bundle, a dead upstream or a typo'd tool name.
    const controlInit = await initMcpSession(OTHER_PLANE, { authHeader: unscopedHeader, clientName: CLIENT_LABEL });
    const control = await mcpToolsCall(OTHER_PLANE, controlInit.sessionId, OTHER_BUNDLE_TOOL, unscopedHeader);
    expect(control.isError).toBeFalsy();
    expect(control.text).toContain("Ada Lovelace");

    // Same endpoint, same tool, install-link key: refused. The key authenticates
    // fine (mcpAuth is not scope-aware, so the session opens) — confinement is
    // enforced at dispatch by checkKeyScopeGate. Note that a bundle scope does
    // NOT filter tools/list by key scope, so this is precisely the "advertised
    // but not callable" case where a tools/list-only assertion would prove
    // nothing.
    const scopedInit = await initMcpSession(OTHER_PLANE, { authHeader, clientName: CLIENT_LABEL });
    const refused = await mcpToolsCall(OTHER_PLANE, scopedInit.sessionId, OTHER_BUNDLE_TOOL, authHeader);
    expect(refused.status).toBe(200);
    expect(refused.isError).toBe(true);
    // Exact text, because the alternative outcome is not a different error — it
    // is the control's SUCCESS above, on a byte-identical request.
    expect(refused.text).toBe(`API key is not authorized to call tool '${OTHER_BUNDLE_TOOL}'`);
    expect(refused.text).not.toContain("Ada Lovelace");

    // The scope is per (client, tool) pair, not per endpoint — so the same key
    // is also refused on a SIBLING tool of the very client the bundle curates,
    // reached through that client's own shard. `create-user` has required
    // arguments and was called with none: a leaked dispatch would have surfaced
    // a schema-validation message instead, so the scope gate provably ran first.
    const shard = `/mcp/${SERVER_A}`;
    const shardInit = await initMcpSession(shard, { authHeader, clientName: CLIENT_LABEL });
    const sibling = await mcpToolsCall(shard, shardInit.sessionId, IN_BUNDLE_SIBLING, authHeader);
    expect(sibling.isError).toBe(true);
    expect(sibling.text).toBe(`API key is not authorized to call tool '${IN_BUNDLE_SIBLING}'`);
    expect(sibling.text).not.toMatch(/validation|required/i);

    // …while the bundle's own tool still works there. Spelled out rather than
    // left implicit: "scoped ONLY to this bundle's tools" means the TOOLS, not
    // the /mcp-custom URL, and a client shard advertises exactly the subset the
    // key may call (mcp-server.ts's scopedToolList filters the client scope).
    expect(await toolNamesOn(shard, shardInit.sessionId, authHeader)).toEqual([IN_BUNDLE]);
    // …which is a real narrowing, not an accident of the client having one tool:
    // an unrestricted key on its own session sees the sibling too.
    const shardControl = await initMcpSession(shard, { authHeader: unscopedHeader, clientName: CLIENT_LABEL });
    expect(await toolNamesOn(shard, shardControl.sessionId, unscopedHeader)).toContain(IN_BUNDLE_SIBLING);

    const allowed = await mcpToolsCall(shard, shardInit.sessionId, IN_BUNDLE, authHeader);
    expect(allowed.isError).toBeFalsy();
    expect(allowed.text).toContain("Ada Lovelace");
  });

  test("revoking the link revokes the key that was already handed out", async () => {
    const record = await mintInstallLinkOk(request, auth, BUNDLE);
    const before = await redeemInstallLink(record.token);
    expect(before.status).toBe(200);
    const { path, authHeader } = connectionFrom(JSON.parse(before.body) as RedeemedInstall, BUNDLE);

    // Establish that the key works *before* the revoke, so the failure after it
    // can only be the revoke.
    const live = await initMcpSession(path, { authHeader, clientName: CLIENT_LABEL });
    const liveCall = await mcpToolsCall(path, live.sessionId, IN_BUNDLE, authHeader);
    expect(liveCall.isError).toBeFalsy();
    expect(liveCall.text).toContain("Ada Lovelace");

    const revoked = await revokeInstallLink(request, auth, BUNDLE, record.id);
    expect(revoked.status, `revoke failed: ${revoked.body}`).toBe(200);
    expect(JSON.parse(revoked.body) as { status: string; id: number }).toEqual({ status: "revoked", id: record.id });

    // Half one: the link is dead, and says so in the same words as a token that
    // never existed (below).
    const after = await redeemInstallLink(record.token);
    expect(after.status).toBe(404);
    expect(errorOf(after.body).code).toBe("INSTALL_LINK_NOT_FOUND");

    // Half two, and the one that matters: the credential a teammate already
    // pasted into their editor stops authenticating. A revocation that only
    // hides the link would leave this working.
    const replay = await rawInitialize(path, authHeader);
    expect(replay.status).toBe(403);
    expect(errorOf(replay.body).code).toBe("FORBIDDEN");

    // Corroborated on the admin side: link and key share one lifecycle.
    const keyRes = await request.get(`${APP_BASE_URL}/admin-api/mcp-keys/${record.mcpKeyId}`, {
      headers: apiHeaders(auth),
    });
    expect(keyRes.status()).toBe(200);
    const key = (await keyRes.json()) as { revokedAt: number | null; enabled: boolean; label: string };
    expect(key.revokedAt).not.toBeNull();
    expect(key.enabled).toBe(false);
    // The key was provisioned for this link, never an admin's personal one.
    expect(key.label).toBe(`install-link:${BUNDLE}`);

    // Revoking twice is a conflict, not a silent success — the link row is soft
    // deleted for the audit trail, so the second call can tell.
    const again = await revokeInstallLink(request, auth, BUNDLE, record.id);
    expect(again.status).toBe(409);
    expect(errorOf(again.body).code).toBe("ALREADY_REVOKED");
  });

  test("an expired link is refused, and is indistinguishable from one that never existed", async () => {
    // expiresAt is a plain epoch-ms number (validateExpiresAt only requires it
    // to be positive), so an already-elapsed value gives the expiry branch
    // without a wait. It is passed through to createMcpKey as well, so the
    // provisioned key is born expired too — there is no window in which the
    // link is dead but its credential is not.
    const record = await mintInstallLinkOk(request, auth, BUNDLE, Date.now() - 1000);
    expect(record.expiresAt).not.toBeNull();

    const redeemed = await redeemInstallLink(record.token);
    expect(redeemed.status).toBe(404);
    expect(errorOf(redeemed.body).code).toBe("INSTALL_LINK_NOT_FOUND");

    // resolveInstallLinkToken's contract is that unknown, revoked and expired
    // are the SAME answer — otherwise a caller can probe a token's history.
    const unknown = await redeemInstallLink("bil_dGhpcy10b2tlbi1kb2VzLW5vdC1leGlzdA");
    expect(unknown.status).toBe(404);
    expect(errorOf(redeemed.body)).toEqual(errorOf(unknown.body));
  });

  test("an unknown token is refused cleanly and discloses nothing about any bundle", async () => {
    // Runs unconditionally: resolveInstallLinkToken returns null on the hash
    // lookup, long before the secrets provider is consulted.
    const garbage = await redeemInstallLink("not-even-a-token");
    const wellFormed = await redeemInstallLink("bil_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    for (const res of [garbage, wellFormed]) {
      expect(res.status).toBe(404);
      expect(errorOf(res.body).code).toBe("INSTALL_LINK_NOT_FOUND");
      expect(res.setCookie).toBeNull();
      // The envelope and nothing else — no bundle, no connect, no partial
      // config for an unauthenticated caller to read.
      expect(Object.keys(JSON.parse(res.body) as Record<string, unknown>)).toEqual(["error"]);
      // And no hint about what does or doesn't exist on this gateway.
      expect(res.body).not.toContain("e2e-install");
      expect(res.body).not.toContain(SERVER_A);
    }

    // Byte-identical `{code, message}` for a malformed token and a well-formed
    // one that simply isn't in the table (only request_id differs), so the
    // shape of a guess never tells an enumerator they got warmer.
    expect(errorOf(garbage.body)).toEqual(errorOf(wellFormed.body));
  });

  test("minting for an empty bundle is refused — an empty scope would mean an unrestricted key", async () => {
    // Also unconditional: createInstallLink checks the bundle BEFORE the secrets
    // provider, so this is the same 400 either way. It guards a real escalation
    // — mcp-key-store's normalizeScopes collapses `{ tools: [] }` to null, which
    // means unrestricted, so minting against an empty bundle would hand a public
    // link a gateway-wide credential.
    const empty = await mintInstallLink(request, auth, EMPTY_BUNDLE);
    expect(empty.status, `expected 400, got ${empty.status}: ${empty.body}`).toBe(400);
    expect(errorOf(empty.body).code).toBe("EMPTY_BUNDLE");

    const missing = await mintInstallLink(request, auth, MISSING_BUNDLE);
    expect(missing.status).toBe(404);
    expect(errorOf(missing.body).code).toBe("BUNDLE_NOT_FOUND");
  });

  test("an operator may read install links but not mint or revoke them", async ({ browser }) => {
    // Minting is gated by requireAdminRole, not requireOperator: an install link
    // is a shareable, unauthenticated-to-redeem credential, so it sits with the
    // admin-only surfaces rather than the operational ones an operator drives.
    // A fresh context so the operator session never inherits the admin cookies.
    const context = await browser.newContext();
    try {
      const operatorPage = await context.newPage();
      const operator = await loginAs(operatorPage, OPERATOR_USERNAME, OPERATOR_PASSWORD);
      const operatorRequest = context.request;

      const minted = await mintInstallLink(operatorRequest, operator, BUNDLE);
      expect(minted.status).toBe(403);
      // The exact message pins WHICH gate fired — requireSuperAdmin (which
      // guards bundle create/update on the same router) words it differently.
      expect(errorOf(minted.body)).toEqual({
        code: "FORBIDDEN",
        message: "This action requires the admin role",
      });

      // Revoke is gated the same way, and the gate runs before the handler: an
      // id that does not exist still answers 403 for the operator…
      const operatorRevoke = await revokeInstallLink(operatorRequest, operator, BUNDLE, 424242);
      expect(operatorRevoke.status).toBe(403);
      // …where the admin gets the handler's own 404. The difference is the
      // proof that the role check short-circuits rather than the route 404ing
      // for everyone.
      const adminRevoke = await revokeInstallLink(request, auth, BUNDLE, 424242);
      expect(adminRevoke.status).toBe(404);
      expect(errorOf(adminRevoke.body).code).toBe("NOT_FOUND");

      // Positive control: the operator IS authenticated and can reach the
      // router — listing is deliberately not role-gated — so the 403s above are
      // the role check, not a broken session or a missing cookie.
      const listed = await operatorRequest.get(`${APP_BASE_URL}/admin-api/bundles/${BUNDLE}/install-links`, {
        headers: apiHeaders(operator),
      });
      expect(listed.status()).toBe(200);
      // Never the raw token, whoever is asking — only a 12-char prefix. (Which
      // is why this is a structural check: "tokenPrefix" contains "token", and
      // its value legitimately starts with "bil_".)
      const items = ((await listed.json()) as { items: Record<string, unknown>[] }).items;
      for (const item of items) expect(item.token).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
