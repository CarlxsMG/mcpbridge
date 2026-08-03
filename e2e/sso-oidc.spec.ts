/**
 * End-to-end coverage for OIDC single sign-on: `src/routes/auth-oidc.ts`
 * (`GET /admin-api/auth/oidc/config`, `/start`, `/callback`, plus the
 * super-admin `/settings` pair) sitting on `src/security/oidc.ts`.
 *
 * ── Why this file hosts no fake identity provider ──────────────────────────
 * The obvious shape for this spec is the one `mcp-upstream.spec.ts` uses:
 * host a throwaway server on an ephemeral loopback port, point the gateway at
 * it, and drive a real login end to end. The IdP side is only HTTP, so that
 * looks reachable — a discovery document, an authorization endpoint, a token
 * endpoint and a JWKS are all serveable, and Node's WebCrypto can mint and
 * sign the ID token. It is nevertheless unreachable here, for two independent
 * reasons found by reading the source rather than by guessing:
 *
 *   1. SSO cannot be switched on in this stack at all. `setOidcConfig`
 *      (src/security/oidc.ts) refuses to store a configuration unless
 *      `getSecretsProvider().isConfigured()` — for the default `local`
 *      provider that is `Boolean(config.secretEncryptionKey)`, i.e. the
 *      `SECRET_ENCRYPTION_KEY` env var. playwright.config.ts's `webServer.env`
 *      does not set it (nor does CI), so every otherwise-valid PUT answers
 *      409 SECRETS_PROVIDER_UNCONFIGURED and writes no row. That function is
 *      the ONLY writer of `oidc_config` anywhere in the codebase, and it is
 *      reached only from `PUT /admin-api/auth/oidc/settings` — no
 *      backup/restore or config-as-code path touches the table — so there is
 *      no side door either. This is asserted below rather than worked around.
 *   2. Independently, `setOidcConfig` requires `issuer` to match
 *      `/^https:\/\//`. A loopback fake IdP speaks plain HTTP and is rejected
 *      at validation time; giving it a self-signed certificate instead would
 *      require the BACKEND process to skip certificate validation
 *      (NODE_TLS_REJECT_UNAUTHORIZED / NODE_EXTRA_CA_CERTS in
 *      playwright.config.ts's `webServer.env`), which a spec cannot set.
 *
 * The consequence is what settles it: with no `oidc_config` row, `/start`
 * short-circuits to 404 before it ever calls `discoverOidcIssuer`, and
 * `/callback` short-circuits at the state check *before* it reads the config
 * (see the ordering assertion below). The gateway can therefore make ZERO
 * outbound requests to an identity provider, and a fake IdP hosted here would
 * never receive a single one. Shipping a signing, JWKS-serving server that
 * nothing calls would be decoration, so this file ships none and covers the
 * surface that is genuinely reachable instead.
 *
 * ── What a fake IdP would have to serve, for whoever unblocks the above ────
 * Recorded here because it was established from source while scoping this file:
 *   - `GET {issuer}/.well-known/openid-configuration` returning at least
 *     `authorization_endpoint`, `token_endpoint` and `jwks_uri` — all three
 *     are required or discovery throws. Cached 10 min per issuer.
 *   - An authorization endpoint that redirects back to `redirect_uri` with the
 *     `state` it was given plus any `code`.
 *   - `POST {token_endpoint}` (form-encoded: grant_type=authorization_code,
 *     code, redirect_uri, client_id, client_secret, code_verifier) returning
 *     2xx JSON with an `id_token`.
 *   - `GET {jwks_uri}` returning `{ keys: [...] }`.
 *   - The ID token must be signed RS256 (RSASSA-PKCS1-v1_5 + SHA-256) or ES256
 *     (ECDSA P-256 + SHA-256) — `verifyJwtSignatureWithKeys` in
 *     src/security/jwt.ts rejects every other `alg`, `none` included. When the
 *     JWT header carries a `kid`, only JWKs with that exact `kid` are tried.
 *   - Claims `verifyIdToken` demands: a numeric `exp` in the future (a token
 *     with no `exp` is reported as "expired", never accepted); `nbf` in the
 *     past if present; `iss` EXACTLY equal to the stored issuer (note
 *     `setOidcConfig` strips trailing slashes before storing); and `aud`
 *     containing the configured `clientId`. The route then additionally
 *     requires a string `sub`.
 *
 * ── Rate-limit budget ─────────────────────────────────────────────────────
 * `/start` and `/callback` share ONE per-IP bucket (`sso:<ip>`, see
 * `rateLimitSso` in src/middleware/rate-limiter.ts) whose ceiling is
 * `config.rateLimitSso`, default 20/min. playwright.config.ts raises the login
 * / register / MCP / global limits but deliberately leaves this one alone, and
 * the whole suite calls from 127.0.0.1, so the budget is genuinely shared.
 * This file spends exactly 5 of those 20 (one `/start`, four `/callback`) and
 * never tries to exhaust the limiter — doing so would poison the bucket for a
 * full minute for anything that runs after it.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { APP_BASE_URL } from "./support/env";
import { apiHeaders, createAdminUser, createTeam, loginAs, setUserTeam, type AdminAuth } from "./support/admin";

// ── Names ───────────────────────────────────────────────────────────────────

const VIEWER_USER = "e2e-sso-viewer";
const TEAM_ADMIN_USER = "e2e-sso-team-admin";
const TEAM_NAME = "e2e-sso-team";
/** >= 12 chars — the POST /admin-api/users rule. */
const TEST_PASSWORD = "e2e-sso-password-2026";

const CONFIG_PATH = "/admin-api/auth/oidc/config";
const START_PATH = "/admin-api/auth/oidc/start";
const CALLBACK_PATH = "/admin-api/auth/oidc/callback";
const SETTINGS_PATH = "/admin-api/auth/oidc/settings";

/** The session cookie `setSessionCookies` writes — no SSO refusal may ever mint one. */
const SESSION_COOKIE = "mcp_admin_session";

/**
 * A payload that satisfies every `setOidcConfig` validation rule, so the only
 * thing left that can reject it is the secrets-provider gate.
 *
 * `enabled` is false in every payload this file sends, deliberately: an
 * enabled-but-unreachable configuration would persist in the shared e2e
 * database and put a "Sign in with SSO" button on the login page for every
 * later spec (LoginPage.vue renders it straight off GET .../oidc/config).
 * The issuer sits under `.invalid` (RFC 2606 — guaranteed never to resolve);
 * nothing in this stack can reach it anyway, but if a future run ever does
 * configure a secrets provider, a stored issuer that provably does not exist
 * cannot turn into an outbound request against somebody else's host.
 */
const VALID_CONFIG: Record<string, unknown> = {
  issuer: "https://e2e-sso-idp.invalid",
  clientId: "e2e-sso-client",
  clientSecret: "e2e-sso-client-secret-value",
  redirectUri: `${APP_BASE_URL}${CALLBACK_PATH}`,
  scopes: "openid profile email",
  enabled: false,
};

function configWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_CONFIG, ...overrides };
}

/** Every key `rowToSettings` (src/security/oidc.ts) emits — note there is no secret among them. */
const SETTINGS_KEYS = ["clientId", "defaultRole", "enabled", "issuer", "redirectUri", "scopes", "updatedAt"];

// ── Helpers ─────────────────────────────────────────────────────────────────

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

interface OidcSettingsShape {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  enabled: boolean;
  defaultRole: string;
  updatedAt: number;
}

/**
 * An anonymous request straight at the bridge, carrying no cookies at all.
 *
 * Raw `fetch` rather than an `APIRequestContext`: the three public SSO
 * endpoints are pre-session BY DEFINITION (a browser hitting them has no
 * session yet), so the caller must be provably credential-free, and
 * `redirect: "manual"` is what lets the 302s below be asserted instead of
 * silently followed into the SPA.
 */
async function anon(path: string): Promise<FetchResponse> {
  return fetch(`${APP_BASE_URL}${path}`, { redirect: "manual" });
}

function errorOf(body: string): { code?: string; message?: string } {
  const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
  return parsed.error ?? {};
}

/** A structured error must stay machine-readable — never a stack frame or an internal path. */
function expectNoInternalDetail(body: string, what: string): void {
  expect(body, `${what} leaked a stack frame`).not.toMatch(/\s+at\s+\S+\s+\(/);
  expect(body, `${what} leaked a source location`).not.toMatch(/\.(ts|js):\d+/);
  expect(body, `${what} leaked a filesystem path`).not.toContain("node_modules");
}

function expectNoSessionMinted(res: FetchResponse, what: string): void {
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie, `${what} minted an admin session`).not.toContain(SESSION_COOKIE);
}

interface CallbackOutcome {
  status: number;
  location: string;
  ssoError: string;
  res: FetchResponse;
}

async function callback(query: string): Promise<CallbackOutcome> {
  const res = await anon(`${CALLBACK_PATH}${query}`);
  const location = res.headers.get("location") ?? "";
  // The handler redirects to a relative path; resolve against the base so the
  // query can be read either way.
  const ssoError = location ? (new URL(location, APP_BASE_URL).searchParams.get("sso_error") ?? "") : "";
  return { status: res.status, location, ssoError, res };
}

async function publicConfig(): Promise<{ enabled: boolean }> {
  const res = await anon(CONFIG_PATH);
  return (await res.json()) as { enabled: boolean };
}

async function getSettings(req: APIRequestContext, who: AdminAuth): Promise<{ status: number; body: string }> {
  const res = await req.get(`${APP_BASE_URL}${SETTINGS_PATH}`, { headers: apiHeaders(who) });
  return { status: res.status(), body: await res.text() };
}

async function putSettings(
  req: APIRequestContext,
  who: AdminAuth,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const res = await req.put(`${APP_BASE_URL}${SETTINGS_PATH}`, { headers: apiHeaders(who), data: payload });
  return { status: res.status(), body: await res.text() };
}

function settingsOf(body: string): OidcSettingsShape | null {
  return (JSON.parse(body) as { settings: OidcSettingsShape | null }).settings;
}

/** Reads the super-admin settings, asserting the call itself succeeded. */
async function readSettings(req: APIRequestContext, who: AdminAuth): Promise<OidcSettingsShape | null> {
  const res = await getSettings(req, who);
  expect(res.status, `GET settings failed: ${res.body}`).toBe(200);
  return settingsOf(res.body);
}

test.describe("OIDC SSO — public config, super-admin gating, and the pre-session callback refusals", () => {
  let page: Page;
  let request: APIRequestContext;
  let superAuth: AdminAuth;

  let viewerContext: BrowserContext;
  let viewerRequest: APIRequestContext;
  let viewerAuth: AdminAuth;

  let teamAdminContext: BrowserContext;
  let teamAdminRequest: APIRequestContext;
  let teamAdminAuth: AdminAuth;

  /** Whether SSO was already switched on before this file touched anything. */
  let baselineEnabled = false;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    request = page.context().request;
    superAuth = await loginAs(page);

    // A plain viewer and a TEAM-SCOPED admin: the settings routes are gated by
    // requireSuperAdmin, not requireAdminRole, and the team admin is the only
    // caller that tells those two apart (admin role, but scoped to a tenant).
    // The bootstrap admin stays teamless and is therefore the super-admin.
    await createAdminUser(request, superAuth, { username: VIEWER_USER, password: TEST_PASSWORD, role: "viewer" });
    await createAdminUser(request, superAuth, { username: TEAM_ADMIN_USER, password: TEST_PASSWORD, role: "admin" });
    const teamId = await createTeam(request, superAuth, TEAM_NAME);
    await setUserTeam(request, superAuth, TEAM_ADMIN_USER, teamId);

    // Separate contexts so neither session inherits the super-admin's cookies.
    viewerContext = await browser.newContext();
    viewerAuth = await loginAs(await viewerContext.newPage(), VIEWER_USER, TEST_PASSWORD);
    viewerRequest = viewerContext.request;

    teamAdminContext = await browser.newContext();
    teamAdminAuth = await loginAs(await teamAdminContext.newPage(), TEAM_ADMIN_USER, TEST_PASSWORD);
    teamAdminRequest = teamAdminContext.request;

    baselineEnabled = (await publicConfig()).enabled;
  });

  test.afterAll(async () => {
    try {
      // HAZARD: the SSO configuration is single-row, global, and lives in the
      // database every later spec shares. An enabled-but-broken config would
      // change the login page for all of them. Every payload this file sends
      // carries `enabled: false`, so this should be a no-op — it exists so
      // that stays true if someone adds a case that flips it, and so a stack
      // that DOES configure a secrets provider (making the PUTs below actually
      // land) still ends the file switched off. There is no DELETE for
      // `oidc_config` — id=1 is upserted — so the restore is a re-PUT with
      // `enabled: false`, which is precisely what `getOidcPublicConfig` reads
      // and therefore what controls the login page.
      const current = await publicConfig();
      if (current.enabled && !baselineEnabled) {
        await putSettings(request, superAuth, configWith({ enabled: false }));
      }
    } finally {
      await viewerContext.close();
      await teamAdminContext.close();
      await page.close();
    }
  });

  // ── The public, pre-session read-model ────────────────────────────────────

  test("the public SSO config endpoint answers an anonymous caller and leaks nothing but `enabled`", async () => {
    const res = await anon(CONFIG_PATH);
    // No auth middleware at all: the login page has to know whether to render
    // an SSO button before any session can exist.
    expect(res.status, "the public SSO config must not require a credential").toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // `getOidcPublicConfig` is deliberately narrow — an unauthenticated caller
    // must not be able to enumerate the IdP the deployment trusts. Pinning the
    // exact key set is what catches a future widening of this read-model.
    expect(Object.keys(body).sort(), "the pre-auth config leaked more than `enabled`").toEqual(["enabled"]);
    expect(typeof body.enabled).toBe("boolean");
  });

  test("SSO reports itself disabled in this stack, so the login page offers no SSO button", async ({ browser }) => {
    // Deterministic, not incidental: no `oidc_config` row can be written here
    // at all (see the file header), so `enabled` can only be false.
    expect((await publicConfig()).enabled).toBe(false);

    const anonContext = await browser.newContext();
    try {
      const anonPage = await anonContext.newPage();
      await anonPage.goto("/admin/login");
      // Selected by id/href rather than by label text on purpose: an earlier
      // spec may have left the UI in Spanish, and these selectors are
      // language-independent.
      await expect(anonPage.locator("#username"), "the login page did not render").toBeVisible();
      await expect(
        anonPage.locator(`a[href="${START_PATH}"]`),
        "the login page offered SSO while SSO is disabled",
      ).toHaveCount(0);
    } finally {
      await anonContext.close();
    }
  });

  // ── /settings is super-admin only ─────────────────────────────────────────

  test("the settings routes require authentication", async () => {
    const res = await anon(SETTINGS_PATH);
    expect(res.status).toBe(401);
    expect(errorOf(await res.text()).code).toBe("UNAUTHORIZED");
  });

  test("a viewer session is refused both the read and the write", async () => {
    const read = await getSettings(viewerRequest, viewerAuth);
    expect(read.status, `viewer read: ${read.body}`).toBe(403);
    expect(errorOf(read.body).code).toBe("FORBIDDEN");

    const write = await putSettings(viewerRequest, viewerAuth, VALID_CONFIG);
    expect(write.status, `viewer write: ${write.body}`).toBe(403);
    expect(errorOf(write.body).code).toBe("FORBIDDEN");
  });

  test("a team-scoped admin is refused — reconfiguring the IdP is a deployment-wide act", async () => {
    // The sharpest case for requireSuperAdmin over requireAdminRole: this
    // caller HAS the admin role and would pass the ordinary admin gate. SSO is
    // the authentication path for every tenant at once, so a tenant-scoped
    // admin repointing the issuer would be a tenancy escape into all of them.
    const read = await getSettings(teamAdminRequest, teamAdminAuth);
    expect(read.status, `team-admin read: ${read.body}`).toBe(403);
    expect(errorOf(read.body).code).toBe("FORBIDDEN");

    const write = await putSettings(teamAdminRequest, teamAdminAuth, VALID_CONFIG);
    expect(write.status, `team-admin write: ${write.body}`).toBe(403);
    expect(errorOf(write.body).code).toBe("FORBIDDEN");
  });

  test("a super-admin can read the settings, and the read-model never carries the client secret", async () => {
    const res = await getSettings(request, superAuth);
    expect(res.status, `super-admin read failed: ${res.body}`).toBe(200);

    // Whatever the row state, the secret is write-only: it is stored as an
    // encrypted `client_secret_ref` and `rowToSettings` never emits it.
    expect(res.body, "the settings read-model echoed a client secret").not.toContain(String(VALID_CONFIG.clientSecret));
    expect(res.body.toLowerCase()).not.toContain("clientsecret");
    expect(res.body).not.toContain("client_secret");

    const settings = settingsOf(res.body);
    if (settings === null) {
      // The expected state here: nothing was ever stored, because nothing can be.
      expect((await publicConfig()).enabled).toBe(false);
      return;
    }
    expect(Object.keys(settings).sort(), "the settings read-model grew a field").toEqual(SETTINGS_KEYS);
  });

  // ── Write-side validation ─────────────────────────────────────────────────

  test("every setOidcConfig validation rule is enforced, and a rejected payload stores nothing", async () => {
    const before = await readSettings(request, superAuth);

    // Ordered exactly as setOidcConfig checks them: each case keeps every
    // earlier field valid so the assertion really is about the field named.
    const cases: { what: string; payload: Record<string, unknown>; mentions: string }[] = [
      // http:// is rejected for the issuer even though it is accepted for the
      // redirect URI — the issuer is where the ID-token signing keys are
      // fetched from, so it must be transport-authenticated.
      { what: "a non-https issuer", payload: configWith({ issuer: "http://e2e-sso-idp.invalid" }), mentions: "issuer" },
      { what: "an empty issuer", payload: configWith({ issuer: "" }), mentions: "issuer" },
      { what: "a missing clientId", payload: configWith({ clientId: "" }), mentions: "clientId" },
      { what: "a non-http(s) redirectUri", payload: configWith({ redirectUri: "ftp://x" }), mentions: "redirectUri" },
      { what: "scopes without openid", payload: configWith({ scopes: "profile email" }), mentions: "openid" },
      { what: "a missing clientSecret", payload: configWith({ clientSecret: "" }), mentions: "clientSecret" },
    ];

    for (const c of cases) {
      const res = await putSettings(request, superAuth, c.payload);
      expect(res.status, `${c.what} was not rejected: ${res.body}`).toBe(400);
      const err = errorOf(res.body);
      expect(err.code, `${c.what}: wrong error code`).toBe("VALIDATION_ERROR");
      expect(err.message ?? "", `${c.what}: message did not name the offending field`).toContain(c.mentions);
      expectNoInternalDetail(res.body, c.what);
    }

    // Validation runs before any write, so the stored state is untouched.
    expect(await readSettings(request, superAuth), "a rejected payload changed the stored config").toEqual(before);
  });

  test("a valid config cannot be stored without a secrets provider, so the secret is never persisted in the clear", async () => {
    // THE contract this environment actually exercises. `setOidcConfig`
    // validates first, then demands `getSecretsProvider().isConfigured()`
    // before it will write — the client secret is only ever persisted through
    // `encryptSecret`, never as plaintext, so an unconfigured provider fails
    // the whole write rather than degrading to storing it raw.
    const res = await putSettings(request, superAuth, VALID_CONFIG);
    expect([200, 409], `unexpected status: ${res.status} ${res.body}`).toContain(res.status);

    if (res.status === 409) {
      // The path this stack takes: playwright.config.ts sets no
      // SECRET_ENCRYPTION_KEY, so the local secrets provider is unconfigured.
      expect(errorOf(res.body).code).toBe("SECRETS_PROVIDER_UNCONFIGURED");
      expectNoInternalDetail(res.body, "the secrets-provider refusal");
      expect(await readSettings(request, superAuth), "a refused write still stored a config").toBeNull();
      expect((await publicConfig()).enabled, "a refused write still enabled SSO").toBe(false);
      return;
    }

    // The other branch, for a stack that DOES configure a secrets provider:
    // the config round-trips, minus the secret, and stays disabled.
    const stored = await readSettings(request, superAuth);
    expect(stored, "a 200 write stored nothing").not.toBeNull();
    expect(stored?.issuer).toBe(VALID_CONFIG.issuer);
    expect(stored?.clientId).toBe(VALID_CONFIG.clientId);
    expect(stored?.redirectUri).toBe(VALID_CONFIG.redirectUri);
    expect(stored?.scopes).toBe(VALID_CONFIG.scopes);
    expect(stored?.enabled, "this file must never leave SSO enabled").toBe(false);
    expect((await publicConfig()).enabled).toBe(false);
  });

  test("defaultRole is not an input — an SSO login cannot be made to mint an admin", async () => {
    // Auto-provisioning hard-codes `viewer` in findOrProvisionSsoUser, and
    // migration 50 pins `oidc_config.default_role` with a DB CHECK. This pins
    // the HTTP surface in front of both: the PUT handler reads no role field
    // whatsoever, so a payload asking for one changes nothing and does not
    // take some other code path around the secrets gate.
    const res = await putSettings(request, superAuth, configWith({ defaultRole: "admin", default_role: "admin" }));
    expect([200, 409], `unexpected status: ${res.status} ${res.body}`).toContain(res.status);

    const stored = await readSettings(request, superAuth);
    if (res.status === 409) {
      expect(errorOf(res.body).code).toBe("SECRETS_PROVIDER_UNCONFIGURED");
      expect(stored, "a refused write still stored a config").toBeNull();
      return;
    }
    expect(stored?.defaultRole, "an SSO config was able to raise its own provisioning role").toBe("viewer");
  });

  // ── The public flow endpoints ─────────────────────────────────────────────

  test("/start is public and, with SSO unconfigured, 404s cleanly without leaking internals", async () => {
    // Spends 1 of the shared 20/min SSO budget — see the file header.
    const res = await anon(START_PATH);

    // 404, not 401: the endpoint is reachable without a credential by design
    // (a browser navigates to it full-page), and it is the CONFIG that is
    // missing, not the caller's authorization.
    expect(res.status, "an unconfigured /start must answer 404, not 401 and not 500").toBe(404);
    const body = await res.text();
    expect(errorOf(body).code).toBe("SSO_NOT_CONFIGURED");
    expectNoInternalDetail(body, "the /start refusal");
    expectNoSessionMinted(res, "/start");
  });

  test("every /callback refusal redirects to the login page with a machine-readable reason and mints no session", async () => {
    // Spends 4 of the shared 20/min SSO budget — see the file header.
    const forgedState = "e2e-sso-forged-state-value";

    const cases: { what: string; query: string; reason: string }[] = [
      // The IdP said no. Checked first, before state/code are even looked at.
      { what: "an IdP-denied callback", query: "?error=access_denied&state=x&code=y", reason: "idp_denied" },
      { what: "a callback with no parameters at all", query: "", reason: "missing_parameters" },
      // Both `state` AND `code` are required — this case is what separates the
      // real `!state || !code` guard from one that only checks `state`.
      { what: "a callback carrying state but no code", query: `?state=${forgedState}`, reason: "missing_parameters" },
      // The heart of it: `state` is a server-generated, single-use, TTL'd row
      // in `oidc_auth_state` that only `/start` can create. A caller who
      // forges one gets nothing. Note the reason is `invalid_state` and NOT
      // `not_configured`, which pins the handler's ordering: the CSRF/state
      // gate fires BEFORE the configuration is consulted, so an unconfigured
      // deployment does not disclose that it is unconfigured to an anonymous
      // caller who never had a valid state to begin with.
      {
        what: "a callback with a forged state and code",
        query: `?state=${forgedState}&code=e2e-sso-forged-code`,
        reason: "invalid_state",
      },
    ];

    for (const c of cases) {
      const out = await callback(c.query);
      expect(out.status, `${c.what} did not redirect: ${out.status}`).toBe(302);
      expect(new URL(out.location, APP_BASE_URL).pathname, `${c.what} redirected somewhere unexpected`).toBe(
        "/admin/login",
      );
      expect(out.ssoError, `${c.what} reported the wrong reason`).toBe(c.reason);
      // The hint handed to the browser stays an opaque token — never a message
      // carrying provider detail, a stack, or why exactly it failed.
      expect(out.ssoError, `${c.what} leaked a non-token reason`).toMatch(/^[a-z_]+$/);
      expectNoInternalDetail(out.location, c.what);
      // The one that matters most: no refusal path may hand out a session.
      expectNoSessionMinted(out.res, c.what);
    }

    // And none of it switched SSO on as a side effect.
    expect((await publicConfig()).enabled).toBe(false);
  });

  // ── The admin UI on top of all of this ────────────────────────────────────

  test("the super-admin SSO settings page renders the read model, and never repopulates the secret", async () => {
    // Expectations are taken from the API read model rather than hardcoded, so
    // this test says the same thing on both stacks: where a secrets provider is
    // configured the tests above really did store a config and the form must
    // show it; where one isn't, every write was refused and the form is empty.
    const stored = await readSettings(request, superAuth);

    await page.goto("/admin/sso");
    // Id-based selectors: language-independent, and they double as a check
    // that the page got past its loading state and its GET /settings call.
    await expect(page.locator("#sso-issuer"), "the SSO settings form did not render").toBeVisible();
    await expect(page.locator("#sso-issuer")).toHaveValue(stored?.issuer ?? "");

    // The assertion that matters, and the reason this test is worth more once a
    // secrets provider IS configured: a client secret has genuinely been stored
    // and encrypted at this point, and the form must STILL come back blank.
    // Against an unconfigured stack the same assertion is vacuous — nothing was
    // ever stored to leak.
    await expect(page.locator("#sso-client-secret"), "the form repopulated a stored client secret").toHaveValue("");
    // Nothing in this file may leave SSO switched on for the specs that follow.
    await expect(
      page.locator('.inline-check input[type="checkbox"]'),
      "the settings page reports SSO enabled",
    ).not.toBeChecked();
  });
});
