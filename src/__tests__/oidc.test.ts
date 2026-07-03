/**
 * OIDC SSO (src/security/oidc.ts): PKCE generation, ID-token verification
 * (valid / expired / wrong issuer / wrong audience / bad signature — all via
 * a locally-generated ES256 keypair and a fake JWKS response, never a real
 * IdP), state-nonce validation, and first-login auto-provisioning vs.
 * second-login identity reuse.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { findUserByUsername } from "../security/user-store.js";
import {
  generatePkcePair,
  verifyIdToken,
  createOidcAuthState,
  consumeOidcAuthState,
  findOrProvisionSsoUser,
  __setOidcDepsForTesting,
  __resetOidcForTesting,
} from "../security/oidc.js";

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

  test("a username collision with a pre-existing, unrelated account never attaches the new identity to it", async () => {
    const hash = await Bun.password.hash("irrelevant-password-1234");
    const { createUser } = await import("../security/user-store.js");
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
