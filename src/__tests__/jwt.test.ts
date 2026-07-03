/**
 * Inbound JWT verification (WebCrypto + JWKS). Generates a real ES256 keypair,
 * signs tokens, serves the public JWK via an injected fetch, and checks the
 * signature + exp/iss/aud paths.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../config.js";
import {
  verifyJwt,
  __setJwtDepsForTesting,
  __resetJwtForTesting,
  verifyJwtSignatureWithKeys,
  createJwksFetcher,
  type Jwk,
} from "../security/jwt.js";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}

async function makeToken(
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
  __setJwtDepsForTesting({
    fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch,
  });
}
const future = () => Math.floor(Date.now() / 1000) + 3600;

const orig = { url: config.jwtJwksUrl, iss: config.jwtIssuer, aud: config.jwtAudience };
function configure(): void {
  (config as Record<string, unknown>).jwtJwksUrl = "https://issuer/.well-known/jwks.json";
  (config as Record<string, unknown>).jwtIssuer = "https://issuer";
  (config as Record<string, unknown>).jwtAudience = "my-api";
}
afterEach(() => {
  (config as Record<string, unknown>).jwtJwksUrl = orig.url;
  (config as Record<string, unknown>).jwtIssuer = orig.iss;
  (config as Record<string, unknown>).jwtAudience = orig.aud;
  __resetJwtForTesting();
});

describe("verifyJwt", () => {
  test("accepts a well-formed, correctly-signed token", async () => {
    configure();
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    serveJwks(jwk);
    const v = await verifyJwt(token);
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.claims.sub).toBe("u1");
  });

  test("rejects expired / wrong issuer / wrong audience", async () => {
    configure();
    const past = Math.floor(Date.now() / 1000) - 10;
    const t1 = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: past });
    serveJwks(t1.jwk);
    expect(await verifyJwt(t1.token)).toMatchObject({ valid: false, reason: "expired" });

    __resetJwtForTesting();
    const t2 = await makeToken({ sub: "u1", iss: "https://evil", aud: "my-api", exp: future() });
    serveJwks(t2.jwk);
    expect(await verifyJwt(t2.token)).toMatchObject({ valid: false, reason: "issuer mismatch" });

    __resetJwtForTesting();
    const t3 = await makeToken({ sub: "u1", iss: "https://issuer", aud: "other", exp: future() });
    serveJwks(t3.jwk);
    expect(await verifyJwt(t3.token)).toMatchObject({ valid: false, reason: "audience mismatch" });
  });

  test("rejects a tampered signature", async () => {
    configure();
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    serveJwks(jwk);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(await verifyJwt(tampered)).toMatchObject({ valid: false });
  });

  test("rejects when no JWKS key matches the kid", async () => {
    configure();
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() }, "k1");
    serveJwks({ ...jwk, kid: "different" });
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "no matching key" });
  });
});

// Reusable building blocks factored out for OIDC ID-token verification (see
// src/security/oidc.ts) — exercised directly here, independent of verifyJwt()'s
// own config-driven issuer/audience/cache, to confirm they work standalone.
describe("verifyJwtSignatureWithKeys (reused by OIDC ID-token verification)", () => {
  test("verifies signature only — does not enforce exp/iss/aud itself", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://anyone", aud: "anyone", exp: past });
    const result = await verifyJwtSignatureWithKeys(token, [jwk as unknown as Jwk]);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.claims.sub).toBe("u1");
  });

  test("rejects a tampered signature", async () => {
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(await verifyJwtSignatureWithKeys(tampered, [jwk as unknown as Jwk])).toMatchObject({ valid: false });
  });
});

describe("createJwksFetcher", () => {
  test("caches keys across calls within cacheMs, keyed independently per URL", async () => {
    let fetchCount = 0;
    let now = 0;
    const fetcher = createJwksFetcher("https://issuer-a/jwks", {
      fetchImpl: (async () => {
        fetchCount++;
        return new Response(JSON.stringify({ keys: [{ kid: "a" }] }), { status: 200 });
      }) as unknown as typeof fetch,
      cacheMs: 1000,
      nowFn: () => now,
    });

    await fetcher();
    await fetcher();
    expect(fetchCount).toBe(1); // second call served from cache

    now += 1001;
    await fetcher();
    expect(fetchCount).toBe(2); // cache expired — refetched
  });

  test("throws on a non-OK response", async () => {
    const fetcher = createJwksFetcher("https://issuer-b/jwks", {
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(fetcher()).rejects.toThrow();
  });
});
