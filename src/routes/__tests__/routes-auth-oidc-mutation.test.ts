/**
 * Stryker mutation-testing backstop for src/routes/auth-oidc.ts — domain 8.
 * The existing hand-written routes-auth-oidc.test.ts (left untouched here)
 * covers: GET /config's "no row" + happy-path-after-enable cases, GET/PUT
 * /settings auth/forbidden gating + null-settings + 409-no-secrets-provider +
 * persist-and-never-echo + non-https-issuer rejection, GET /start's
 * 404-not-configured + successful-redirect cases, and GET /callback's
 * idp-error / invalid-state / state-replay / happy-path / second-login-
 * reuses-identity cases.
 *
 * It never touches: discovery failures (either endpoint's own try/catch —
 * two textually distinct blocks), the "config exists but disabled" half of
 * either `!cfg || !cfg.enabled` OR clause (only "no config at all" is
 * exercised), the callback's client-secret-decrypt failure, token-exchange
 * failure, missing id_token, invalid id_token (claims mismatch), missing
 * subject, account-disabled, the PUT body's typeof/length guard clusters
 * beyond the non-https-issuer case, the scopes fallback's compound
 * typeof+trim condition, the enabled strict-equality check, the recordAudit
 * call's exact arguments, or the /start redirect's "scope" query param.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { createUser, updateUser } from "../../security/user-store.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import { __resetOidcForTesting, __setOidcDepsForTesting, createOidcAuthState } from "../../security/oidc.js";
import * as auditMod from "../../admin/audit/audit.js";
import * as loggerMod from "../../logger.js";

let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __resetOidcForTesting();
  const { authRoutes } = await import("../../routes/auth.js");
  const { authOidcRoutes } = await import("../../routes/auth-oidc.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  authRoutes(app);
  authOidcRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

function cookieHeaderFrom(res: Response): string {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}
async function makeIdToken(claims: Record<string, unknown>): Promise<{ token: string; jwk: Record<string, unknown> }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<string, unknown>;
  jwk.kid = "k1";
  jwk.alg = "ES256";
  const signingInput = `${b64urlJson({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(signingInput)),
  );
  return { token: `${signingInput}.${b64url(sig)}`, jwk };
}

const ADMIN_KEY = "test-admin-key-auth-oidc-mut";
const ISSUER = "https://issuer-mut.example.com";
const CLIENT_ID = "test-client-id-mut";
const REDIRECT_URI = "https://bridge.example.com/admin-api/auth/oidc/callback";

/**
 * Wires up a fake discovery doc + JWKS + token endpoint for ISSUER through
 * the injected fetch. `idTokenClaims: null` makes the token endpoint's
 * response omit `id_token` entirely (for the missing_id_token branch);
 * `wellKnownStatus` simulates a discovery outage (for both discovery-failure
 * branches); `tokenEndpointStatus` simulates a bad token-exchange response.
 */
async function fakeIdp(
  opts: {
    idTokenClaims?: Record<string, unknown> | null;
    tokenEndpointStatus?: number;
    wellKnownStatus?: number;
  } = {},
): Promise<{ tokenRequests: URLSearchParams[] }> {
  const tokenRequests: URLSearchParams[] = [];
  let token = "";
  let jwk: Record<string, unknown> = {};
  if (opts.idTokenClaims !== null) {
    const claims = opts.idTokenClaims ?? {
      sub: "idp-subject-1",
      iss: ISSUER,
      aud: CLIENT_ID,
      email: "alice@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const made = await makeIdToken(claims);
    token = made.token;
    jwk = made.jwk;
  }

  __setOidcDepsForTesting({
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === `${ISSUER}/.well-known/openid-configuration`) {
        if (opts.wellKnownStatus && opts.wellKnownStatus !== 200) {
          return new Response("discovery error", { status: opts.wellKnownStatus });
        }
        return new Response(
          JSON.stringify({
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
          { status: 200 },
        );
      }
      if (u === `${ISSUER}/jwks`) {
        return new Response(JSON.stringify({ keys: jwk.kid ? [jwk] : [] }), { status: 200 });
      }
      if (u === `${ISSUER}/token`) {
        tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
        if (opts.tokenEndpointStatus && opts.tokenEndpointStatus !== 200) {
          return new Response("token error", { status: opts.tokenEndpointStatus });
        }
        const body: Record<string, unknown> = { access_token: "at", expires_in: 3600 };
        if (opts.idTokenClaims !== null) body.id_token = token;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  });
  return { tokenRequests };
}

const origSecretKey = config.secretEncryptionKey;
function configureSecretBox(key = 9): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, key).toString("base64");
}

beforeEach(() => {
  (config as Record<string, unknown>).secretEncryptionKey = origSecretKey;
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  _internalsForTesting.loginBuckets.clear();
});
afterEach(async () => {
  (config as Record<string, unknown>).secretEncryptionKey = origSecretKey;
  __resetOidcForTesting();
  await stopServer();
});

async function seedSuperAdmin(username: string, password: string) {
  const hash = await Bun.password.hash(password);
  return createUser(username, hash, "admin", null);
}

async function loginAs(username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = cookieHeaderFrom(res);
  const { csrf_token } = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: csrf_token };
}

function putSettingsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "shh-its-a-secret",
    redirectUri: REDIRECT_URI,
    scopes: "openid email",
    enabled: true,
    ...overrides,
  };
}

async function putSettings(overrides: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
    method: "PUT",
    headers: bearer(),
    body: JSON.stringify(putSettingsBody(overrides)),
  });
}

async function getSettings(): Promise<{ settings: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, { headers: bearer() });
  return (await res.json()) as { settings: Record<string, unknown> | null };
}

async function startFlow(): Promise<string> {
  const startRes = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
  const location = new URL(startRes.headers.get("location")!);
  return location.searchParams.get("state")!;
}

describe("GET /admin-api/auth/oidc/config — configured-but-disabled branch", () => {
  // Existing suite only exercises "no row at all" (row === null). A row that
  // EXISTS but is currently disabled exercises the OTHER clause of
  // `row !== null && row.enabled === 1` — a forced-true mutant on that
  // second clause would wrongly report enabled:true here.
  test("reports disabled when a config row exists but enabled=false", async () => {
    await startApp();
    configureSecretBox();
    const putRes = await putSettings({ enabled: false });
    expect(putRes.status).toBe(200);

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});

describe("PUT /admin-api/auth/oidc/settings — body-parsing + validation gaps", () => {
  test("no request body at all (no Content-Type) fails validation cleanly, not a 500", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
      method: "PUT",
      headers: bearer(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("issuer must be an https:// URL");
  });

  test("a non-string, truthy issuer fails validation instead of crashing", async () => {
    await startApp();
    const res = await putSettings({ issuer: 12345 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("issuer must be an https:// URL");
  });

  test("a missing clientId fails validation with the exact message", async () => {
    await startApp();
    const res = await putSettings({ clientId: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("clientId is required");
  });

  test("a non-string, truthy clientId fails validation instead of crashing", async () => {
    await startApp();
    const res = await putSettings({ clientId: 42 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("clientId is required");
  });

  test("a missing clientSecret fails validation with the exact message", async () => {
    await startApp();
    const res = await putSettings({ clientSecret: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("clientSecret is required");
  });

  test("a non-string, truthy clientSecret fails validation instead of crashing", async () => {
    await startApp();
    const res = await putSettings({ clientSecret: 999 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("clientSecret is required");
  });

  test("a non-http(s) redirectUri fails validation with the exact message", async () => {
    await startApp();
    const res = await putSettings({ redirectUri: "ftp://bad.example.com/cb" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("redirectUri must be an http(s) URL");
  });

  test("a non-string, truthy redirectUri fails validation instead of crashing", async () => {
    await startApp();
    const res = await putSettings({ redirectUri: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("redirectUri must be an http(s) URL");
  });

  test("scopes present but missing 'openid' fails validation with the exact message", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ scopes: "profile email" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("scopes must include 'openid'");
  });

  // Kills the `typeof body.scopes === "string" && body.scopes.trim()`
  // compound condition's typeof half: a non-string scopes value must fall
  // back to the default (which includes 'openid'), not be used raw (which
  // would crash calling .trim() on a number inside setOidcConfig).
  test("a non-string scopes value falls back to the default scope list", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ scopes: 12345 });
    expect(res.status).toBe(200);
    const { settings } = await getSettings();
    expect(settings?.scopes).toBe("openid profile email");
  });

  test("an empty-string scopes value falls back to the default scope list", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ scopes: "" });
    expect(res.status).toBe(200);
    const { settings } = await getSettings();
    expect(settings?.scopes).toBe("openid profile email");
  });

  // Kills the `.trim()` call itself (a MethodExpression mutant removing it):
  // whitespace-only scopes is truthy BEFORE trimming but falsy after, so
  // only a genuine `.trim()` correctly falls back to the default here — a
  // mutant without it would pass "   " straight through to setOidcConfig,
  // which fails the 'openid' substring check and returns 400 instead of 200.
  test("a whitespace-only scopes value is trimmed and falls back to the default (not passed through raw)", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ scopes: "   " });
    expect(res.status).toBe(200);
    const { settings } = await getSettings();
    expect(settings?.scopes).toBe("openid profile email");
  });

  // Kills the `body.enabled === true` StrictEquality mutant's forced-true
  // direction and any loose-equality swap: a truthy but non-boolean value
  // must NOT be treated as enabled.
  test("a truthy but non-boolean enabled value is treated as disabled", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ enabled: "true" });
    expect(res.status).toBe(200);
    const { settings } = await getSettings();
    expect(settings?.enabled).toBe(false);
    const publicRes = await fetch(`${baseUrl}/admin-api/auth/oidc/config`);
    expect(await publicRes.json()).toEqual({ enabled: false });
  });

  // Kills a ConditionalExpression forcing `enabled` always true regardless
  // of input — an explicit `enabled: false` must persist as false.
  test("an explicit enabled:false persists as disabled", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings({ enabled: false });
    expect(res.status).toBe(200);
    const { settings } = await getSettings();
    expect(settings?.enabled).toBe(false);
  });

  // Exact recordAudit + log arguments, using the RAW (unnormalized) issuer
  // value — the route passes its own local `issuer` const into both calls,
  // not setOidcConfig's trimmed/trailing-slash-stripped version, so a
  // trailing slash proves which one is actually being used.
  test("a successful PUT records the exact audit detail and log line with raw field values", async () => {
    await startApp();
    configureSecretBox();
    const auditSpy = spyOn(auditMod, "recordAudit");
    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await putSettings({ issuer: `${ISSUER}/` });
      expect(res.status).toBe(200);
      expect(auditSpy).toHaveBeenCalledWith("bearer:admin-api-key", "oidc.config.update", "oidc:config", {
        issuer: `${ISSUER}/`,
        clientId: CLIENT_ID,
        enabled: true,
      });
      expect(logSpy).toHaveBeenCalledWith(
        "info",
        "OIDC SSO config updated",
        expect.objectContaining({ actor: "bearer:admin-api-key", enabled: true }),
      );
    } finally {
      auditSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("PUT with SECRETS_PROVIDER_UNCONFIGURED returns the exact 409 message without ever calling recordAudit", async () => {
    await startApp();
    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await putSettings();
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SECRETS_PROVIDER_UNCONFIGURED");
      expect(body.error.message).toBe(
        "Configure a secrets provider (SECRET_ENCRYPTION_KEY or Vault) before enabling SSO",
      );
      expect(auditSpy).not.toHaveBeenCalled();
    } finally {
      auditSpy.mockRestore();
    }
  });

  // Distinct from SECRETS_PROVIDER_UNCONFIGURED (isConfigured() returning
  // false before ever calling encryptSecret): this exercises the OTHER
  // secrets-provider failure branch, where isConfigured() is true but the
  // actual encrypt call throws (a genuine Vault outage). Uses the real
  // 'vault' provider pointed at a closed local port so the connection is
  // refused immediately (no DNS, no hung timeout).
  test("a secrets-provider encrypt failure (configured but unreachable) returns 502 SECRETS_PROVIDER_ERROR", async () => {
    await startApp();
    const orig = {
      provider: config.secretsProvider,
      addr: config.vaultAddr,
      token: config.vaultToken,
      timeout: config.vaultRequestTimeoutMs,
    };
    (config as Record<string, unknown>).secretsProvider = "vault";
    (config as Record<string, unknown>).vaultAddr = "http://127.0.0.1:1";
    (config as Record<string, unknown>).vaultToken = "test-token";
    (config as Record<string, unknown>).vaultRequestTimeoutMs = 3000;
    try {
      const res = await putSettings();
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SECRETS_PROVIDER_ERROR");
    } finally {
      (config as Record<string, unknown>).secretsProvider = orig.provider;
      (config as Record<string, unknown>).vaultAddr = orig.addr;
      (config as Record<string, unknown>).vaultToken = orig.token;
      (config as Record<string, unknown>).vaultRequestTimeoutMs = orig.timeout;
    }
  });

  test("a successful PUT returns the exact { status: 'updated' } response body", async () => {
    await startApp();
    configureSecretBox();
    const res = await putSettings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "updated" });
  });
});

describe("GET /admin-api/auth/oidc/start — additional coverage", () => {
  test("discovery failure returns the exact 502 SSO_DISCOVERY_FAILED and logs a warning", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({ wellKnownStatus: 500 });

    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SSO_DISCOVERY_FAILED");
      expect(body.error.message).toBe("Could not reach the identity provider");
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "OIDC discovery failed",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  // Kills the `!cfg.enabled` half of `!cfg || !cfg.enabled` for a config row
  // that DOES exist — the existing suite only exercises the "no row at all"
  // half.
  test("returns 404 SSO_NOT_CONFIGURED when a config row exists but is disabled", async () => {
    await startApp();
    configureSecretBox();
    await putSettings({ enabled: false });

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("SSO_NOT_CONFIGURED");
    expect(body.error.message).toBe("SSO is not enabled");
  });

  // The existing suite never checks the "scope" query param at all.
  test("the redirect carries the exact configured scopes under the 'scope' param", async () => {
    await startApp();
    configureSecretBox();
    await putSettings({ scopes: "openid email profile" });
    await fakeIdp();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("GET /admin-api/auth/oidc/callback — additional coverage", () => {
  // Exact reason string (not just "toContain sso_error=") — the existing
  // suite's own idp-error test only checks the generic redirect prefix,
  // which can't distinguish a forced-false/EqualityOperator/StringLiteral
  // mutant on the idpError ternary (all of which fall through to a
  // DIFFERENT reason, e.g. invalid_state, for the exact same request).
  test("an IdP error param produces the EXACT idp_denied reason (state/code present but otherwise unused)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?error=access_denied&state=x&code=y`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login?sso_error=idp_denied");
  });

  // Kills the idpError ternary's ConditionalExpression-forced-TRUE mutant:
  // a repeated `error` query param parses to an ARRAY (non-string), which
  // real code must treat as absent (falls through to missing_parameters,
  // since state/code are also absent here), not as a truthy idp_denied
  // trigger.
  test("a non-string (array) error query param is not treated as an IdP error", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?error=a&error=b`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_parameters");
  });

  // Kills the `state` ternary's ConditionalExpression-forced-TRUE mutant: a
  // repeated `state` query param (array) must be treated as absent.
  test("a non-string (array) state query param is treated as missing, not a real state", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?state=a&state=b&code=abc`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_parameters");
  });

  // Kills the `code` ternary's ConditionalExpression-forced-TRUE mutant: a
  // repeated `code` query param (array) must be treated as absent.
  test("a non-string (array) code query param is treated as missing, not a real code", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?state=abc&code=a&code=b`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_parameters");
  });

  test("a missing state (code present) is rejected the same as an invalid one", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_parameters");
  });

  test("a missing code (state present) is rejected the same way", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp();
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_parameters");
    // The state must NOT have been consumed by a partial/short-circuited
    // check — it should still be usable afterward.
    const state2 = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(state2.headers.get("location")).not.toContain("invalid_state");
  });

  // No oidc_config row has EVER been created (cfg === null) — distinct from
  // the "exists but disabled" case below. The auth-state row is created
  // directly, bypassing /start (which would itself 404 with no config).
  test("not_configured when no oidc_config row exists at all", async () => {
    await startApp();
    const state = createOidcAuthState("bypass-verifier-1");

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=not_configured");
  });

  // Config row exists but disabled — the OTHER half of `!cfg || !cfg.enabled`.
  test("not_configured when the oidc_config row exists but is disabled", async () => {
    await startApp();
    configureSecretBox();
    await putSettings({ enabled: false });
    const state = createOidcAuthState("bypass-verifier-2");

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=not_configured");
  });

  // Distinct catch block from /start's own discovery try/catch — bypasses
  // /start entirely (which would have its own, already-covered, discovery
  // failure) so the auth state is created directly.
  test("discovery failure during the callback itself redirects with discovery_failed and logs its OWN distinct warning", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({ wellKnownStatus: 500 });
    const state = createOidcAuthState("bypass-verifier-3");

    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("sso_error=discovery_failed");
      // Distinct message from /start's own "OIDC discovery failed" — proves
      // this is the callback's OWN try/catch, not a shared code path.
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "OIDC discovery failed during callback",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  // Client-secret decryption failure: the config was encrypted under one
  // key, then the key is swapped for a DIFFERENT valid 32-byte key before
  // the callback runs, so decryptSecret's AES-GCM auth-tag check throws.
  test("a client-secret decryption failure redirects with server_error and logs it at error level", async () => {
    await startApp();
    configureSecretBox(9);
    await putSettings();
    await fakeIdp();
    const state = await startFlow();
    configureSecretBox(200); // swap to a different key AFTER encryption

    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("sso_error=server_error");
      expect(logSpy).toHaveBeenCalledWith(
        "error",
        "OIDC client secret decryption failed",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a non-2xx token endpoint response redirects with token_exchange_failed and logs a warning", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({ tokenEndpointStatus: 400 });
    const state = await startFlow();

    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("sso_error=token_exchange_failed");
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "OIDC token exchange failed",
        expect.objectContaining({ error: expect.any(String) }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a token response with no id_token field redirects with missing_id_token", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({ idTokenClaims: null });
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_id_token");
  });

  test("an id_token with the wrong audience redirects with invalid_token and logs the reason", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({
      idTokenClaims: {
        sub: "idp-subject-badaud",
        iss: ISSUER,
        aud: "someone-elses-client-id",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const state = await startFlow();

    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("sso_error=invalid_token");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        "warn",
        "OIDC id_token verification failed",
        expect.objectContaining({ reason: "audience mismatch" }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a valid id_token missing 'sub' redirects with missing_subject", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({
      idTokenClaims: {
        iss: ISSUER,
        aud: CLIENT_ID,
        email: "no-subject@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_subject");
  });

  // A non-string `sub` claim (a number) — distinguishes the `typeof
  // verdict.claims.sub === "string"` guard's forced-true direction from a
  // simple truthiness check.
  test("a numeric (non-string) 'sub' claim redirects with missing_subject", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({
      idTokenClaims: {
        sub: 123456,
        iss: ISSUER,
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=missing_subject");
  });

  test("a deactivated, previously-provisioned SSO user is rejected with account_disabled and no session", async () => {
    await startApp();
    configureSecretBox();
    await putSettings();
    await fakeIdp({
      idTokenClaims: {
        sub: "idp-subject-disableme",
        iss: ISSUER,
        aud: CLIENT_ID,
        email: "disableme@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    const state1 = await startFlow();
    const logSpy = spyOn(loggerMod, "log");
    let firstRes: Response;
    try {
      firstRes = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=code-a&state=${state1}`, {
        redirect: "manual",
        headers: { "User-Agent": "auth-oidc-mut-agent/1.0" },
      });
      expect(firstRes.status).toBe(302);
      expect(firstRes.headers.get("location")).toBe("/admin/servers");
      // Kills the "SSO login succeeded" log call's StringLiteral/ObjectLiteral
      // mutants — the existing suite's happy-path test never spies on log.
      expect(logSpy).toHaveBeenCalledWith(
        "info",
        "SSO login succeeded",
        expect.objectContaining({ username: expect.any(String) }),
      );
    } finally {
      logSpy.mockRestore();
    }

    // Kills the "user-agent" header-key StringLiteral mutant on
    // `req.headers["user-agent"]` — a real User-Agent must actually be
    // recorded on the newly created session.
    const firstCookie = cookieHeaderFrom(firstRes);
    const sessionsRes = await fetch(`${baseUrl}/admin-api/auth/sessions`, { headers: { Cookie: firstCookie } });
    const sessionsBody = (await sessionsRes.json()) as { sessions: { userAgent: string | null }[] };
    expect(sessionsBody.sessions.some((s) => s.userAgent === "auth-oidc-mut-agent/1.0")).toBe(true);

    const identityRow = getDb()
      .query(`SELECT user_id FROM admin_user_identities WHERE subject = ?`)
      .get("idp-subject-disableme") as { user_id: number } | null;
    expect(identityRow).not.toBeNull();
    const username = getDb().query(`SELECT username FROM admin_users WHERE id = ?`).get(identityRow!.user_id) as {
      username: string;
    };
    expect(updateUser(username.username, { isActive: false })).toBe(true);

    const state2 = await startFlow();
    const secondRes = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=code-b&state=${state2}`, {
      redirect: "manual",
    });
    expect(secondRes.status).toBe(302);
    expect(secondRes.headers.get("location")).toContain("sso_error=account_disabled");
    expect(secondRes.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /admin-api/auth/oidc/settings — 403 does not leak an audit record", () => {
  test("a non-super-admin session PUT is forbidden and never calls recordAudit", async () => {
    await startApp();
    const hash = await Bun.password.hash("operator-password-mut-1");
    createUser("op-mut", hash, "operator", null);
    const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "op-mut", password: "operator-password-mut-1" }),
    });
    const cookie = cookieHeaderFrom(loginRes);
    const { csrf_token } = (await loginRes.json()) as { csrf_token: string };

    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf_token },
        body: JSON.stringify(putSettingsBody()),
      });
      expect(res.status).toBe(403);
      expect(auditSpy).not.toHaveBeenCalled();
    } finally {
      auditSpy.mockRestore();
    }
  });

  test("a super-admin SESSION caller (not bearer) can also PUT settings and is recorded by username", async () => {
    await startApp();
    configureSecretBox();
    await seedSuperAdmin("root-mut", "super-admin-password-mut-1");
    const { cookie, csrf } = await loginAs("root-mut", "super-admin-password-mut-1");

    const auditSpy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
        body: JSON.stringify(putSettingsBody()),
      });
      expect(res.status).toBe(200);
      expect(auditSpy).toHaveBeenCalledWith(
        "root-mut",
        "oidc.config.update",
        "oidc:config",
        expect.objectContaining({ issuer: ISSUER, clientId: CLIENT_ID, enabled: true }),
      );
    } finally {
      auditSpy.mockRestore();
    }
  });
});
