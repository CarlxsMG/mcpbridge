/**
 * OIDC SSO (src/security/oidc.ts): PKCE generation, ID-token verification
 * (valid / expired / wrong issuer / wrong audience / bad signature — all via
 * a locally-generated ES256 keypair and a fake JWKS response, never a real
 * IdP), state-nonce validation, and first-login auto-provisioning vs.
 * second-login identity reuse.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { findUserByUsername } from "../../security/user-store.js";
import * as logger from "../../logger.js";
import {
  generatePkcePair,
  verifyIdToken,
  createOidcAuthState,
  consumeOidcAuthState,
  findOrProvisionSsoUser,
  discoverOidcIssuer,
  exchangeAuthorizationCode,
  setOidcConfig,
  getOidcPublicConfig,
  getOidcSettings,
  getOidcConfigInternal,
  OIDC_STATE_TTL_MS,
  __setOidcDepsForTesting,
  __resetOidcForTesting,
} from "../../security/oidc.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "test-client-id";
const JWKS_URI = `${ISSUER}/jwks.json`;
const future = () => Math.floor(Date.now() / 1000) + 3600;

async function makeIdToken(
  claims: Record<string, unknown>,
  kid = "k1",
): Promise<{ token: string; jwk: Record<string, unknown> }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = "ES256";
  const signingInput = `${b64urlJson({ alg: "ES256", kid, typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(signingInput)),
  );
  return { token: `${signingInput}.${b64url(sig)}`, jwk };
}

function serveJwks(jwk: Record<string, unknown>): void {
  __setOidcDepsForTesting({
    fetch: (async (url: string | URL) => {
      if (String(url) === JWKS_URI) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  });
}

beforeEach(() => {
  __resetDbForTesting();
  __resetOidcForTesting();
});
afterEach(() => {
  __resetOidcForTesting();
});

describe("generatePkcePair", () => {
  test("produces a verifier of adequate entropy and a matching S256 challenge", async () => {
    const { codeVerifier, codeChallenge } = await generatePkcePair();

    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, unreserved chars only

    const expectedDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
    );
    const expectedChallenge = b64url(expectedDigest);
    expect(codeChallenge).toBe(expectedChallenge);
  });

  test("two calls never produce the same verifier", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe("verifyIdToken", () => {
  test("accepts a well-formed, correctly-signed token from the expected issuer/audience", async () => {
    const { token, jwk } = await makeIdToken({ sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: future() });
    serveJwks(jwk);

    const result = await verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.claims.sub).toBe("user-1");
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { token, jwk } = await makeIdToken({ sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: past });
    serveJwks(jwk);

    const result = await verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result).toMatchObject({ valid: false, reason: "expired" });
  });

  test("rejects a token from the wrong issuer", async () => {
    const { token, jwk } = await makeIdToken({
      sub: "user-1",
      iss: "https://evil.example.com",
      aud: AUDIENCE,
      exp: future(),
    });
    serveJwks(jwk);

    const result = await verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result).toMatchObject({ valid: false, reason: "issuer mismatch" });
  });

  test("rejects a token for the wrong audience", async () => {
    const { token, jwk } = await makeIdToken({ sub: "user-1", iss: ISSUER, aud: "some-other-client", exp: future() });
    serveJwks(jwk);

    const result = await verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result).toMatchObject({ valid: false, reason: "audience mismatch" });
  });

  test("rejects a tampered signature", async () => {
    const { token, jwk } = await makeIdToken({ sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: future() });
    serveJwks(jwk);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === "AA" ? "BB" : "AA"}`;

    const result = await verifyIdToken(tampered, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result.valid).toBe(false);
  });

  test("rejects when the JWKS has no matching key", async () => {
    const { token, jwk } = await makeIdToken({ sub: "user-1", iss: ISSUER, aud: AUDIENCE, exp: future() }, "k1");
    serveJwks({ ...jwk, kid: "some-other-key" });

    const result = await verifyIdToken(token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    expect(result).toMatchObject({ valid: false, reason: "no matching key" });
  });
});

describe("OIDC auth-state (PKCE code_verifier) store", () => {
  test("a freshly created state resolves back to its code_verifier exactly once", () => {
    const state = createOidcAuthState("verifier-abc");
    expect(consumeOidcAuthState(state)).toBe("verifier-abc");
  });

  test("reusing an already-consumed state is rejected", () => {
    const state = createOidcAuthState("verifier-abc");
    expect(consumeOidcAuthState(state)).toBe("verifier-abc");
    expect(consumeOidcAuthState(state)).toBeNull();
  });

  test("a state value that was never issued is rejected", () => {
    expect(consumeOidcAuthState("never-issued-state")).toBeNull();
  });

  test("an expired state is rejected even though the row hasn't been read yet", () => {
    let now = 1_000_000;
    __setOidcDepsForTesting({ now: () => now });
    const state = createOidcAuthState("verifier-xyz");
    now += 11 * 60 * 1000; // past the 10-minute TTL
    expect(consumeOidcAuthState(state)).toBeNull();
  });
});

describe("findOrProvisionSsoUser", () => {
  test("first login auto-provisions a new admin_users row with role fixed to 'viewer'", async () => {
    const user = await findOrProvisionSsoUser("oidc", "subject-1", { sub: "subject-1", email: "alice@example.com" });
    expect(user.role).toBe("viewer");
    expect(user.isActive).toBe(true);

    const stored = findUserByUsername(user.username);
    expect(stored?.id).toBe(user.id);
  });

  test("second login for the same (provider, subject) reuses the identity mapping — no duplicate admin_users row", async () => {
    const first = await findOrProvisionSsoUser("oidc", "subject-2", { sub: "subject-2", email: "bob@example.com" });
    const countAfterFirst = (getDb().query(`SELECT COUNT(*) AS n FROM admin_users`).get() as { n: number }).n;

    const second = await findOrProvisionSsoUser("oidc", "subject-2", { sub: "subject-2", email: "bob@example.com" });
    const countAfterSecond = (getDb().query(`SELECT COUNT(*) AS n FROM admin_users`).get() as { n: number }).n;

    expect(second.id).toBe(first.id);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  test("two concurrent first-time logins for the same (provider, subject) never race: exactly one admin_users row, both resolve to it", async () => {
    // Regression test: without a per-(provider, subject) mutex, both calls
    // would pass the pre-checks (findIdentityUserId → null) before either
    // committed, then race createUser's INSERT on admin_users' UNIQUE
    // username constraint (or linkIdentity's on admin_user_identities'
    // UNIQUE(provider, subject)) — one call would throw instead of both
    // resolving to the same user.
    const claims = { sub: "subject-race", email: "race@example.com" };
    const [a, b] = await Promise.all([
      findOrProvisionSsoUser("oidc", "subject-race", claims),
      findOrProvisionSsoUser("oidc", "subject-race", claims),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.username).toBe(b.username);

    const userCount = (
      getDb().query(`SELECT COUNT(*) AS n FROM admin_users WHERE username = ?`).get(a.username) as { n: number }
    ).n;
    expect(userCount).toBe(1);

    const identityCount = (
      getDb()
        .query(`SELECT COUNT(*) AS n FROM admin_user_identities WHERE provider = 'oidc' AND subject = ?`)
        .get("subject-race") as { n: number }
    ).n;
    expect(identityCount).toBe(1);
  });

  test("a username collision with a pre-existing, unrelated account never attaches the new identity to it", async () => {
    const hash = await Bun.password.hash("irrelevant-password-1234");
    const { createUser } = await import("../../security/user-store.js");
    const preexisting = createUser("carol", hash, "admin", null);

    // A different SSO subject whose derived username would also be "carol".
    const provisioned = await findOrProvisionSsoUser("oidc", "subject-3", {
      sub: "subject-3",
      email: "carol@example.com",
    });

    expect(provisioned.id).not.toBe(preexisting.id);
    expect(provisioned.username).not.toBe("carol");
    expect(provisioned.role).toBe("viewer");
  });
});

// ===========================================================================
// Mutation backstop (P2-8). Three iterations took oidc.ts from a 30.53%
// baseline to 94.66% (248/262). The blocks below pin discovery, the token
// exchange, oidc_config CRUD + setOidcConfig validation (incl. the https/http
// URL-scheme anchors), verifyIdToken's nbf/exp-boundary/array-aud/jwks-error
// paths, username derivation, and the auto-provision log.
//
// The 14 remaining survivors are all equivalent or deep, non-security infra:
//   - L149 nbf `typeof === "number"` → true, L151 aud `[]`: same as jwt (every
//     token has numeric claims; a no-aud token mismatches any real audience).
//   - L227 `!row` in consumeOidcAuthState: expired rows are already DELETEd by
//     cleanupExpiredAuthState() before the SELECT, so the check is redundant.
//   - L330 `/\s+/` → `/\s/` in the scopes split: `.includes("openid")` is
//     unaffected by the extra empty segments a single-space split produces.
//   - L394 email `typeof === "string"` → true, L415/L417 identity-reuse guards,
//     L425 random SSO password: each fall-through yields the same result
//     (sso-<hash> username / findUserById(null) → null / an unused password).
//   - L107/L121 (discovery TTL-cache nowFn option, jwks-fetcher memoization) and
//     L343/L344 (the secrets-provider encrypt-error branch): fetch/cache infra
//     the injectable-deps pattern can't distinguish or can't force to throw.
// ===========================================================================

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const GOOD_DISCOVERY = {
  authorization_endpoint: "https://idp/auth",
  token_endpoint: "https://idp/token",
  jwks_uri: "https://idp/jwks",
};
const GOOD_CONFIG = {
  issuer: "https://idp.example.com",
  clientId: "cid",
  clientSecret: "sec-value",
  redirectUri: "https://app.example.com/callback",
  scopes: "openid profile",
  enabled: true,
};

function serveDiscovery(doc: unknown, status = 200): void {
  __setOidcDepsForTesting({
    fetch: (async (url: string | URL) => {
      if (String(url).includes("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(doc), { status });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch,
  });
}

describe("verifyIdToken — nbf / exp boundary / array audience / jwks error", () => {
  const opts = { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI };

  test("a future nbf → 'not yet valid'", async () => {
    const nbf = Math.floor(Date.now() / 1000) + 3600;
    const { token, jwk } = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: future(), nbf });
    serveJwks(jwk);
    expect(await verifyIdToken(token, opts)).toMatchObject({ valid: false, reason: "not yet valid" });
  });

  test("a token missing exp → 'expired' (kills L148 typeof)", async () => {
    const { token, jwk } = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE });
    serveJwks(jwk);
    expect(await verifyIdToken(token, opts)).toMatchObject({ valid: false, reason: "expired" });
  });

  test("exp exactly equal to now is expired (kills L148 `>=` → `>`)", async () => {
    const nowSec = 1_700_000_000;
    const { token, jwk } = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: nowSec });
    serveJwks(jwk);
    __setOidcDepsForTesting({ now: () => nowSec * 1000 });
    expect(await verifyIdToken(token, opts)).toMatchObject({ valid: false, reason: "expired" });
  });

  test("audience as an array — accepts when listed, rejects when absent (kills L151)", async () => {
    const t1 = await makeIdToken({ sub: "u", iss: ISSUER, aud: ["other", AUDIENCE], exp: future() });
    serveJwks(t1.jwk);
    expect(await verifyIdToken(t1.token, opts)).toMatchObject({ valid: true });
    __resetOidcForTesting();
    const t2 = await makeIdToken({ sub: "u", iss: ISSUER, aud: ["x", "y"], exp: future() });
    serveJwks(t2.jwk);
    expect(await verifyIdToken(t2.token, opts)).toMatchObject({ valid: false, reason: "audience mismatch" });
  });

  test("a JWKS fetch failure → 'jwks: ...' (kills L140/141)", async () => {
    const { token } = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: future() });
    __setOidcDepsForTesting({
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const r = await verifyIdToken(token, opts);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain("jwks:");
  });
});

describe("discoverOidcIssuer", () => {
  test("fetches and returns the discovery document", async () => {
    serveDiscovery(GOOD_DISCOVERY);
    expect((await discoverOidcIssuer(ISSUER)).token_endpoint).toBe("https://idp/token");
  });

  test("throws on a non-OK response (kills L99)", async () => {
    serveDiscovery({}, 500);
    await expect(discoverOidcIssuer(ISSUER)).rejects.toThrow("OIDC discovery fetch failed: HTTP 500");
  });

  test("throws when a required endpoint is missing (kills L101/102)", async () => {
    serveDiscovery({ authorization_endpoint: "https://idp/auth", token_endpoint: "https://idp/token" }); // no jwks_uri
    await expect(discoverOidcIssuer(ISSUER)).rejects.toThrow("missing a required endpoint");
  });

  test("caches within TTL and refetches for a different issuer (kills L112 issuer-cache logic)", async () => {
    let count = 0;
    __setOidcDepsForTesting({
      fetch: (async () => {
        count++;
        return new Response(JSON.stringify(GOOD_DISCOVERY), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await discoverOidcIssuer(ISSUER);
    await discoverOidcIssuer(ISSUER);
    expect(count).toBe(1); // same issuer → cached
    await discoverOidcIssuer("https://other-issuer.example.com");
    expect(count).toBe(2); // different issuer → reset + refetch
  });
});

describe("exchangeAuthorizationCode", () => {
  test("POSTs the authorization_code grant with every param and returns the token response", async () => {
    let body = "";
    let method = "";
    __setOidcDepsForTesting({
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        body = String(init?.body);
        method = String(init?.method);
        return new Response(JSON.stringify({ id_token: "idt", access_token: "at" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await exchangeAuthorizationCode("https://idp/token", {
      code: "the-code",
      redirectUri: "https://app/cb",
      clientId: "cid",
      clientSecret: "the-secret",
      codeVerifier: "the-verifier",
    });
    expect(res.id_token).toBe("idt");
    expect(method).toBe("POST");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("code_verifier=the-verifier");
    expect(body).toContain("client_secret=the-secret");
    expect(body).toContain("redirect_uri=");
  });

  test("throws on a non-OK response (kills L184)", async () => {
    __setOidcDepsForTesting({
      fetch: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });
    await expect(
      exchangeAuthorizationCode("https://idp/token", {
        code: "c",
        redirectUri: "r",
        clientId: "ci",
        clientSecret: "cs",
        codeVerifier: "v",
      }),
    ).rejects.toThrow("OIDC token exchange failed: HTTP 400");
  });
});

describe("setOidcConfig — validation (kills L316-337)", () => {
  test("rejects a non-https issuer", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, issuer: "http://idp" });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    if (!r.ok) expect(r.reason).toContain("issuer");
  });
  test("rejects a blank clientId", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, clientId: "   " });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    if (!r.ok) expect(r.reason).toContain("clientId");
  });
  test("rejects a non-http(s) redirectUri", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, redirectUri: "ftp://app/cb" });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    if (!r.ok) expect(r.reason).toContain("redirectUri");
  });
  test("rejects scopes without 'openid'", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, scopes: "profile email" });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    if (!r.ok) expect(r.reason).toContain("openid");
  });
  test("rejects a missing clientSecret", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, clientSecret: "" });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
    if (!r.ok) expect(r.reason).toContain("clientSecret");
  });
  test("rejects when no secrets provider is configured", async () => {
    const r = await withConfig({ secretEncryptionKey: "" }, () => setOidcConfig(GOOD_CONFIG));
    expect(r).toMatchObject({ ok: false, error: "SECRETS_PROVIDER_UNCONFIGURED" });
  });
});

describe("oidc_config CRUD (kills L265-365)", () => {
  test("getters are empty/disabled when unconfigured", () => {
    expect(getOidcSettings()).toBeNull();
    expect(getOidcConfigInternal()).toBeNull();
    expect(getOidcPublicConfig().enabled).toBe(false);
  });

  test("a valid config persists and reads back, never leaking the secret", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      const r = await setOidcConfig(GOOD_CONFIG);
      expect(r.ok).toBe(true);
      expect(getOidcPublicConfig().enabled).toBe(true);
      const s = getOidcSettings();
      expect(s?.issuer).toBe("https://idp.example.com");
      expect(s?.clientId).toBe("cid");
      expect(s?.redirectUri).toBe("https://app.example.com/callback");
      expect(s?.defaultRole).toBe("viewer");
      expect(JSON.stringify(s)).not.toContain("sec-value"); // secret never surfaced
      expect(getOidcConfigInternal()?.clientSecretRef).toBeTruthy();
    });
  });

  test("a disabled config reads back enabled:false (kills L275/286 enabled mapping)", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      await setOidcConfig({ ...GOOD_CONFIG, enabled: false });
      expect(getOidcPublicConfig().enabled).toBe(false);
      expect(getOidcSettings()?.enabled).toBe(false);
    });
  });

  test("issuer trailing slashes are stripped and empty scopes default (kills L317/320)", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      await setOidcConfig({ ...GOOD_CONFIG, issuer: "https://idp.example.com///", scopes: "   " });
      const s = getOidcSettings();
      expect(s?.issuer).toBe("https://idp.example.com");
      expect(s?.scopes).toBe("openid profile email");
    });
  });
});

describe("OIDC auth-state — exact TTL boundary", () => {
  test("a state is still valid at the exact TTL instant (kills L227 `<` → `<=`)", () => {
    let now = 1_000_000;
    __setOidcDepsForTesting({ now: () => now });
    const state = createOidcAuthState("v");
    now += OIDC_STATE_TTL_MS; // expires_at === now
    expect(consumeOidcAuthState(state)).toBe("v"); // `<` keeps it valid; `<=` would expire it
  });
});

describe("findOrProvisionSsoUser — username derivation (kills L383-397)", () => {
  test("derives from the email local-part, slugified", async () => {
    const u = await findOrProvisionSsoUser("oidc", "s1", { sub: "s1", email: "Alice.Smith+tag@example.com" });
    expect(u.username).toBe("alice.smithtag"); // lowercased, '+' stripped, '.' kept
  });

  test("with no email, derives an sso-<hash> username", async () => {
    const u = await findOrProvisionSsoUser("oidc", "s2", { sub: "s2" });
    expect(u.username).toMatch(/^sso-[0-9a-f]{8}$/);
  });
});

describe("oidc — iteration 2 (boundaries, trailing slashes, exact reasons, log)", () => {
  test("discovery strips trailing slashes from the issuer before the well-known path (kills L95)", async () => {
    let sawUrl = "";
    __setOidcDepsForTesting({
      fetch: (async (url: string | URL) => {
        sawUrl = String(url);
        return new Response(JSON.stringify(GOOD_DISCOVERY), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await discoverOidcIssuer("https://idp.example.com///");
    expect(sawUrl).toBe("https://idp.example.com/.well-known/openid-configuration");
  });

  test("discovery throws when authorization_endpoint or token_endpoint is missing (kills L101 sub-conditions)", async () => {
    serveDiscovery({ token_endpoint: "https://idp/token", jwks_uri: "https://idp/jwks" });
    await expect(discoverOidcIssuer(ISSUER)).rejects.toThrow("missing a required endpoint");
    __resetOidcForTesting();
    serveDiscovery({ authorization_endpoint: "https://idp/auth", jwks_uri: "https://idp/jwks" });
    await expect(discoverOidcIssuer(ISSUER)).rejects.toThrow("missing a required endpoint");
  });

  test("a past nbf is accepted; nbf exactly now is accepted (kills L149 `&&`→`||` and `<`→`<=`)", async () => {
    const nowSec = 1_700_000_000;
    const past = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: nowSec + 3600, nbf: nowSec - 100 });
    serveJwks(past.jwk);
    __setOidcDepsForTesting({ now: () => nowSec * 1000 });
    expect(await verifyIdToken(past.token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI })).toMatchObject({
      valid: true,
    });

    __resetOidcForTesting();
    const exact = await makeIdToken({ sub: "u", iss: ISSUER, aud: AUDIENCE, exp: nowSec + 3600, nbf: nowSec });
    serveJwks(exact.jwk);
    __setOidcDepsForTesting({ now: () => nowSec * 1000 });
    expect(await verifyIdToken(exact.token, { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI })).toMatchObject({
      valid: true,
    });
  });

  test("getOidcSettings reflects enabled:true (kills L275)", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      await setOidcConfig(GOOD_CONFIG);
      expect(getOidcSettings()?.enabled).toBe(true);
    });
  });

  test("setOidcConfig trims surrounding whitespace on issuer/redirectUri (kills L317/L319 .trim())", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      const r = await setOidcConfig({
        ...GOOD_CONFIG,
        issuer: "  https://idp.example.com  ",
        redirectUri: "  https://app.example.com/cb  ",
      });
      expect(r.ok).toBe(true);
      expect(getOidcSettings()?.issuer).toBe("https://idp.example.com");
      expect(getOidcSettings()?.redirectUri).toBe("https://app.example.com/cb");
    });
  });

  test("the unconfigured-secrets error carries a clear reason (kills L337)", async () => {
    const r = await withConfig({ secretEncryptionKey: "" }, () => setOidcConfig(GOOD_CONFIG));
    expect(r).toMatchObject({ ok: false, error: "SECRETS_PROVIDER_UNCONFIGURED" });
    if (!r.ok) expect(r.reason).toContain("secrets provider");
  });

  test("an email whose local-part slugifies to empty falls back to 'user' (kills L389)", async () => {
    const u = await findOrProvisionSsoUser("oidc", "s-empty", { sub: "s-empty", email: "+++@example.com" });
    expect(u.username).toBe("user");
  });

  test("a username collision suffixes with provider + subject hash (kills L397)", async () => {
    const { createUser } = await import("../../security/user-store.js");
    createUser("alice", await Bun.password.hash("irrelevant-pw-here"), "admin", null);
    const u = await findOrProvisionSsoUser("google", "coll-subj", { sub: "coll-subj", email: "alice@example.com" });
    expect(u.username).toMatch(/^alice-google-[0-9a-f]{8}$/);
  });

  test("exchangeAuthorizationCode sends form-urlencoded content type (kills L180)", async () => {
    let contentType = "";
    __setOidcDepsForTesting({
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        contentType = String((init?.headers as Record<string, string>)?.["Content-Type"]);
        return new Response(JSON.stringify({ id_token: "x" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await exchangeAuthorizationCode("https://idp/token", {
      code: "c",
      redirectUri: "r",
      clientId: "ci",
      clientSecret: "cs",
      codeVerifier: "v",
    });
    expect(contentType).toBe("application/x-www-form-urlencoded");
  });

  test("auto-provisioning logs the new SSO user at info with username/provider/role (kills L427)", async () => {
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const u = await findOrProvisionSsoUser("okta", "log-subj", { sub: "log-subj", email: "dan@example.com" });
      const call = logSpy.mock.calls.find((c) => String(c[1]).includes("Auto-provisioned"));
      expect(call?.[0]).toBe("info");
      expect(call?.[2]).toMatchObject({ username: u.username, provider: "okta", role: "viewer" });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("oidc — iteration 3 (URL-scheme validation anchors, timeout signal, state cleanup)", () => {
  test("an issuer that merely CONTAINS https:// (not anchored) is rejected (kills L323 `^` anchor)", async () => {
    const r = await setOidcConfig({ ...GOOD_CONFIG, issuer: "evil-https://idp.example.com" });
    expect(r).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
  });

  test("redirectUri: http:// is allowed but a non-anchored scheme is rejected (kills L327 `?` and `^`)", async () => {
    await withConfig({ secretEncryptionKey: KEY_B64 }, async () => {
      // `https?` explicitly allows http; dropping the `?` would wrongly reject it.
      const ok = await setOidcConfig({ ...GOOD_CONFIG, redirectUri: "http://localhost:3000/cb" });
      expect(ok.ok).toBe(true);
    });
    // Merely containing http:// (not anchored at the start) must be rejected.
    const bad = await setOidcConfig({ ...GOOD_CONFIG, redirectUri: "x-http://app/cb" });
    expect(bad).toMatchObject({ ok: false, error: "VALIDATION_ERROR" });
  });

  test("discovery passes an abort signal (request timeout) to fetch (kills L96)", async () => {
    let sawSignal = false;
    __setOidcDepsForTesting({
      fetch: (async (_url: string | URL, init?: { signal?: unknown }) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return new Response(JSON.stringify(GOOD_DISCOVERY), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await discoverOidcIssuer(ISSUER);
    expect(sawSignal).toBe(true);
  });

  test("creating a state purges already-expired rows (kills L197 cleanup)", () => {
    let now = 1_000_000;
    __setOidcDepsForTesting({ now: () => now });
    const stale = createOidcAuthState("stale-verifier");
    now += OIDC_STATE_TTL_MS + 1; // `stale` is now past its TTL
    createOidcAuthState("fresh-verifier"); // this create runs cleanupExpiredAuthState(now)
    const remaining = (getDb().query(`SELECT COUNT(*) AS n FROM oidc_auth_state`).get() as { n: number }).n;
    expect(remaining).toBe(1); // only the fresh row survives; the stale one was purged
    expect(consumeOidcAuthState(stale)).toBeNull();
  });
});
