/**
 * HTTP-level tests for src/routes/auth-oidc.ts — real express() instance +
 * native fetch(), matching the routes-auth.test.ts convention. The IdP is
 * always faked via oidc.ts's injectable fetch (__setOidcDepsForTesting) —
 * this suite never calls a real identity provider.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { createUser } from "../../security/user-store.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import { __resetOidcForTesting, __setOidcDepsForTesting } from "../../security/oidc.js";

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

const ISSUER = "https://issuer.example.com";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://bridge.example.com/admin-api/auth/oidc/callback";

/**
 * Wires up a fake discovery doc + JWKS + token endpoint for ISSUER, all served
 * through the injected fetch. The id_token and its signing keypair are
 * generated ONCE up front so the token endpoint's id_token and the JWKS
 * endpoint's public key are always for the same keypair (as a real IdP's
 * would be), regardless of which order the routes fetch them in.
 */
async function fakeIdp(
  opts: { idTokenClaims?: Record<string, unknown>; tokenEndpointStatus?: number } = {},
): Promise<{ tokenRequests: URLSearchParams[] }> {
  const tokenRequests: URLSearchParams[] = [];
  const claims = opts.idTokenClaims ?? {
    sub: "idp-subject-1",
    iss: ISSUER,
    aud: CLIENT_ID,
    email: "alice@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const { token, jwk } = await makeIdToken(claims);

  __setOidcDepsForTesting({
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === `${ISSUER}/.well-known/openid-configuration`) {
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
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (u === `${ISSUER}/token`) {
        tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
        if (opts.tokenEndpointStatus && opts.tokenEndpointStatus !== 200) {
          return new Response("error", { status: opts.tokenEndpointStatus });
        }
        return new Response(JSON.stringify({ id_token: token, access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  });
  return { tokenRequests };
}

const origSecretKey = config.secretEncryptionKey;
function configureSecretBox(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 9).toString("base64");
}

beforeEach(() => {
  (config as Record<string, unknown>).secretEncryptionKey = origSecretKey;
  // The login rate limiter is a module-level singleton keyed by IP, never
  // reset by __resetDbForTesting — this file logs in many times from the
  // same loopback address, so it must be cleared per test (matching the
  // precedent in routes-register.test.ts / routes-catalog.test.ts).
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

async function enableSso(cookie: string, csrf: string): Promise<Response> {
  return fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: JSON.stringify({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shh-its-a-secret",
      redirectUri: REDIRECT_URI,
      scopes: "openid email",
      enabled: true,
    }),
  });
}

describe("GET /admin-api/auth/oidc/config (public)", () => {
  test("returns disabled with no config at all", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  test("never requires a session cookie or CSRF token", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/config`, { headers: {} });
    expect(res.status).toBe(200);
  });
});

describe("/admin-api/auth/oidc/settings (superadmin-only)", () => {
  test("GET/PUT both require authentication", async () => {
    await startApp();
    const getRes = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`);
    expect(getRes.status).toBe(401);
    const putRes = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, { method: "PUT" });
    expect(putRes.status).toBe(401);
  });

  test("a non-super-admin (operator role) session is forbidden", async () => {
    await startApp();
    const hash = await Bun.password.hash("operator-password-123");
    createUser("op1", hash, "operator", null);
    const { cookie, csrf } = await loginAs("op1", "operator-password-123");

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);

    const putRes = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({
        issuer: ISSUER,
        clientId: "x",
        clientSecret: "y",
        redirectUri: REDIRECT_URI,
        scopes: "openid",
        enabled: true,
      }),
    });
    expect(putRes.status).toBe(403);
  });

  test("super-admin GET returns null settings before any config is saved", async () => {
    await startApp();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie } = await loginAs("root", "super-admin-password-1");

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: null });
  });

  test("PUT without a secrets provider configured returns 409", async () => {
    await startApp();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie, csrf } = await loginAs("root", "super-admin-password-1");

    const res = await enableSso(cookie, csrf);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SECRETS_PROVIDER_UNCONFIGURED");
  });

  test("PUT persists config, never echoes the secret, and GET /config flips to enabled", async () => {
    await startApp();
    configureSecretBox();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie, csrf } = await loginAs("root", "super-admin-password-1");

    const putRes = await enableSso(cookie, csrf);
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, { headers: { Cookie: cookie } });
    const body = (await getRes.json()) as { settings: Record<string, unknown> };
    expect(body.settings).toMatchObject({ issuer: ISSUER, clientId: CLIENT_ID, enabled: true, defaultRole: "viewer" });
    expect(body.settings.clientSecret).toBeUndefined();
    expect(body.settings.clientSecretRef).toBeUndefined();

    const publicRes = await fetch(`${baseUrl}/admin-api/auth/oidc/config`);
    expect(await publicRes.json()).toEqual({ enabled: true });
  });

  test("PUT rejects a non-https issuer", async () => {
    await startApp();
    configureSecretBox();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie, csrf } = await loginAs("root", "super-admin-password-1");

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({
        issuer: "http://insecure.example.com",
        clientId: CLIENT_ID,
        clientSecret: "shh",
        redirectUri: REDIRECT_URI,
        scopes: "openid",
        enabled: true,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin-api/auth/oidc/start", () => {
  test("returns 404 when SSO isn't configured/enabled", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  test("redirects to the discovered authorization_endpoint with state + PKCE challenge", async () => {
    await startApp();
    configureSecretBox();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie, csrf } = await loginAs("root", "super-admin-password-1");
    await enableSso(cookie, csrf);
    await fakeIdp();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("state")).toBeTruthy();
  });
});

describe("GET /admin-api/auth/oidc/callback", () => {
  async function startFlow(): Promise<string> {
    const startRes = await fetch(`${baseUrl}/admin-api/auth/oidc/start`, { redirect: "manual" });
    const location = new URL(startRes.headers.get("location")!);
    return location.searchParams.get("state")!;
  }

  async function setupEnabledSso(): Promise<void> {
    configureSecretBox();
    await seedSuperAdmin("root", "super-admin-password-1");
    const { cookie, csrf } = await loginAs("root", "super-admin-password-1");
    await enableSso(cookie, csrf);
  }

  test("an IdP error param redirects back to login with sso_error, no session created", async () => {
    await startApp();
    await setupEnabledSso();
    await fakeIdp();
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?error=access_denied&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login?sso_error=");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("an invalid/unknown state is rejected", async () => {
    await startApp();
    await setupEnabledSso();
    await fakeIdp();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc&state=totally-made-up`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sso_error=invalid_state");
  });

  test("a state value cannot be replayed a second time", async () => {
    await startApp();
    await setupEnabledSso();
    await fakeIdp();
    const state = await startFlow();

    const first = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc123&state=${state}`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/admin/servers");

    const replay = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=abc123&state=${state}`, {
      redirect: "manual",
    });
    expect(replay.headers.get("location")).toContain("sso_error=invalid_state");
  });

  test("happy path: exchanges the code, verifies the id_token, auto-provisions a viewer, and sets session cookies", async () => {
    await startApp();
    await setupEnabledSso();
    const { tokenRequests } = await fakeIdp({
      idTokenClaims: {
        sub: "idp-subject-42",
        iss: ISSUER,
        aud: CLIENT_ID,
        email: "newuser@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const state = await startFlow();

    const res = await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=real-code&state=${state}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/servers");

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);

    // The token exchange actually carried the PKCE code_verifier through.
    expect(tokenRequests.length).toBe(1);
    expect(tokenRequests[0].get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0].get("code")).toBe("real-code");
    expect(tokenRequests[0].get("code_verifier")).toBeTruthy();

    const cookie = cookieHeaderFrom(res);
    const meRes = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { username: string; role: string } };
    expect(me.user.role).toBe("viewer");

    const identityRow = getDb()
      .query(`SELECT provider, subject, user_id FROM admin_user_identities WHERE subject = ?`)
      .get("idp-subject-42") as { provider: string; subject: string; user_id: number } | null;
    expect(identityRow).not.toBeNull();
    expect(identityRow?.provider).toBe("oidc");
  });

  test("a second login for the same subject reuses the identity — no duplicate admin_users row", async () => {
    await startApp();
    await setupEnabledSso();
    await fakeIdp({
      idTokenClaims: {
        sub: "idp-subject-99",
        iss: ISSUER,
        aud: CLIENT_ID,
        email: "repeat@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    const state1 = await startFlow();
    await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=code-1&state=${state1}`, { redirect: "manual" });
    const countAfterFirst = (getDb().query(`SELECT COUNT(*) AS n FROM admin_users`).get() as { n: number }).n;

    const state2 = await startFlow();
    await fetch(`${baseUrl}/admin-api/auth/oidc/callback?code=code-2&state=${state2}`, { redirect: "manual" });
    const countAfterSecond = (getDb().query(`SELECT COUNT(*) AS n FROM admin_users`).get() as { n: number }).n;

    expect(countAfterSecond).toBe(countAfterFirst);
    const identityRows = getDb()
      .query(`SELECT COUNT(*) AS n FROM admin_user_identities WHERE subject = ?`)
      .get("idp-subject-99") as { n: number };
    expect(identityRows.n).toBe(1);
  });
});
