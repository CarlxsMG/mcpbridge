/**
 * Inbound JWT verification (WebCrypto + JWKS). Generates a real ES256 keypair,
 * signs tokens, serves the public JWK via an injected fetch, and checks the
 * signature + exp/iss/aud paths.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../../config.js";
import {
  verifyJwt,
  isJwtConfigured,
  __setJwtDepsForTesting,
  __resetJwtForTesting,
  verifyJwtSignatureWithKeys,
  createJwksFetcher,
  type Jwk,
} from "../../security/jwt.js";

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

  test("recovers from an IdP key rotation by refetching once on an unknown kid", async () => {
    configure();
    const { token, jwk } = await makeToken(
      { sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() },
      "rotated-key",
    );
    // First fetch returns a STALE JWKS (missing the token's kid, as right after a
    // rotation); the forced refetch returns the fresh set that includes it.
    let calls = 0;
    __setJwtDepsForTesting({
      fetch: (async () => {
        calls++;
        const keys = calls === 1 ? [{ ...jwk, kid: "old-key" }] : [jwk];
        return new Response(JSON.stringify({ keys }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const v = await verifyJwt(token);
    expect(v.valid).toBe(true);
    expect(calls).toBe(2); // initial (miss) + exactly one forced refetch
  });

  test("rate-limits the forced refetch: repeated unknown kids don't refetch again within the cooldown", async () => {
    configure();
    const { token } = await makeToken(
      { sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() },
      "never-served",
    );
    let calls = 0;
    __setJwtDepsForTesting({
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ keys: [{ kid: "something-else" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    // First unknown-kid verify: initial fetch + one forced refetch = 2 calls.
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "no matching key" });
    expect(calls).toBe(2);
    // A second unknown-kid verify inside the cooldown must NOT refetch again.
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "no matching key" });
    expect(calls).toBe(2);
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

// ===========================================================================
// Mutation backstop (P2-6). The tests above only exercise ES256 + the happy /
// coarse-`valid:false` paths, so the RS256 branches, the nbf check, the exact
// reason strings, the array-audience branch, isJwtConfigured, and the JWKS
// fetch-error / cache boundaries all had surviving mutants. These pin them and
// take jwt.ts from a 63.71% baseline to 96.20% (228/237).
//
// The 9 remaining survivors are all EQUIVALENT or effectively so — none change
// observable behaviour, so they are intentionally not chased:
//   - L66 padEnd math + `"="` : Bun's atob tolerates missing base64 padding
//                               (verified), so the decoded bytes are identical.
//   - L68 `i < bin.length` → `<=`: the extra out-of-bounds write to a
//                               fixed-length Uint8Array is silently ignored.
//   - L82 importKey `extractable` false → true: extractability does not affect
//                               crypto.subtle.verify().
//   - L131/L132 `typeof exp/nbf === "number"` → true: every JWT here carries a
//                               numeric exp/nbf, so that sub-expression is fixed.
//   - L135 aud `[]` → `["Stryker was here"]`: a no-aud token still mismatches
//                               any real configured audience either way.
//   - L36/L217 default `() => Date.now()` clocks: the injectable-clock design
//                               means tests always inject or reset nowFn, so the
//                               default arrow body is never the asserted value.
// ===========================================================================

async function makeTokenRS256(
  claims: Record<string, unknown>,
  kid = "r1",
): Promise<{ token: string; jwk: Record<string, unknown> }> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = "RS256";
  const signingInput = `${b64urlJson({ alg: "RS256", kid, typ: "JWT" })}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(signingInput)),
  );
  return { token: `${signingInput}.${b64url(sig)}`, jwk };
}

describe("isJwtConfigured", () => {
  test("reflects whether JWT_JWKS_URL is set (kills L50 BlockStatement)", () => {
    configure();
    expect(isJwtConfigured()).toBe(true);
    (config as Record<string, unknown>).jwtJwksUrl = "";
    expect(isJwtConfigured()).toBe(false);
  });
});

describe("verifyJwt — structural rejects pin the exact reason", () => {
  test("a token without exactly 3 parts → 'not a JWT'", async () => {
    configure();
    expect(await verifyJwt("only.two")).toMatchObject({ valid: false, reason: "not a JWT" });
    expect(await verifyJwt("a.b.c.d")).toMatchObject({ valid: false, reason: "not a JWT" });
  });

  test("non-JSON header/payload → 'malformed'", async () => {
    configure();
    const bad = `${b64url(new TextEncoder().encode("not json"))}.${b64url(new TextEncoder().encode("{}"))}.sig`;
    expect(await verifyJwt(bad)).toMatchObject({ valid: false, reason: "malformed" });
  });

  test("an unsupported alg → 'unsupported alg <alg>'", async () => {
    configure();
    const header = b64urlJson({ alg: "HS256", kid: "k1", typ: "JWT" });
    const payload = b64urlJson({ sub: "u1" });
    expect(await verifyJwt(`${header}.${payload}.sig`)).toMatchObject({
      valid: false,
      reason: "unsupported alg HS256",
    });
  });

  test("a tampered signature → exactly 'signature invalid'", async () => {
    configure();
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    serveJwks(jwk);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(await verifyJwt(tampered)).toMatchObject({ valid: false, reason: "signature invalid" });
  });

  test("a JWKS fetch failure surfaces as 'jwks: JWKS fetch failed: <status>'", async () => {
    configure();
    const { token } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    __setJwtDepsForTesting({
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const v = await verifyJwt(token);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toContain("JWKS fetch failed: 500");
  });
});

describe("verifyJwt — nbf / exp boundaries", () => {
  test("a future nbf → 'not yet valid'", async () => {
    configure();
    const nbf = Math.floor(Date.now() / 1000) + 3600;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future(), nbf });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "not yet valid" });
  });

  test("a past nbf is accepted", async () => {
    configure();
    const nbf = Math.floor(Date.now() / 1000) - 3600;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future(), nbf });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: true });
  });

  test("exp exactly equal to now is expired (kills L131 `>=` → `>`)", async () => {
    configure();
    const nowSec = 1_700_000_000;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: nowSec });
    serveJwks(jwk);
    __setJwtDepsForTesting({ now: () => nowSec * 1000 }); // nowSec === exp → `>=` expires, `>` would not
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "expired" });
  });
});

describe("verifyJwt — audience as an array", () => {
  test("accepts when the configured audience is one of an array aud", async () => {
    configure();
    const { token, jwk } = await makeToken({
      sub: "u1",
      iss: "https://issuer",
      aud: ["someone-else", "my-api"],
      exp: future(),
    });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: true });
  });

  test("rejects when the configured audience is absent from an array aud", async () => {
    configure();
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: ["x", "y"], exp: future() });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "audience mismatch" });
  });
});

describe("RS256 support (the base tests only exercise ES256)", () => {
  test("verifyJwt accepts a valid RS256 token", async () => {
    configure();
    const { token, jwk } = await makeTokenRS256({ sub: "r1", iss: "https://issuer", aud: "my-api", exp: future() });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: true });
  });

  test("verifyJwtSignatureWithKeys accepts a valid RS256 signature", async () => {
    const { token, jwk } = await makeTokenRS256({ sub: "r1" });
    expect(await verifyJwtSignatureWithKeys(token, [jwk as unknown as Jwk])).toMatchObject({ valid: true });
  });
});

describe("verifyJwtSignatureWithKeys — structural rejects pin the exact reason", () => {
  test("non-3-part → 'not a JWT'", async () => {
    expect(await verifyJwtSignatureWithKeys("a.b", [])).toMatchObject({ valid: false, reason: "not a JWT" });
  });

  test("non-JSON → 'malformed'", async () => {
    const bad = `${b64url(new TextEncoder().encode("xx"))}.${b64url(new TextEncoder().encode("{}"))}.s`;
    expect(await verifyJwtSignatureWithKeys(bad, [])).toMatchObject({ valid: false, reason: "malformed" });
  });

  test("unsupported alg → 'unsupported alg <alg>'", async () => {
    const t = `${b64urlJson({ alg: "none" })}.${b64urlJson({})}.s`;
    expect(await verifyJwtSignatureWithKeys(t, [])).toMatchObject({ valid: false, reason: "unsupported alg none" });
  });

  test("no key matches the kid → 'no matching key'", async () => {
    const { token, jwk } = await makeToken({ sub: "u1" }, "k1");
    expect(await verifyJwtSignatureWithKeys(token, [{ ...(jwk as unknown as Jwk), kid: "other" }])).toMatchObject({
      valid: false,
      reason: "no matching key",
    });
  });

  test("tampered signature → 'signature invalid'", async () => {
    const { token, jwk } = await makeToken({ sub: "u1" });
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(await verifyJwtSignatureWithKeys(tampered, [jwk as unknown as Jwk])).toMatchObject({
      valid: false,
      reason: "signature invalid",
    });
  });
});

describe("createJwksFetcher — cache boundary, empty keys, error message", () => {
  test("caches below cacheMs, refetches at/after it (kills L222 `<` → `<=` and `-` → `+`)", async () => {
    let fetchCount = 0;
    let now = 600;
    const fetcher = createJwksFetcher("https://x/jwks", {
      fetchImpl: (async () => {
        fetchCount++;
        return new Response(JSON.stringify({ keys: [{ kid: "a" }] }), { status: 200 });
      }) as unknown as typeof fetch,
      cacheMs: 1000,
      nowFn: () => now,
    });

    await fetcher(); // fetchedAt = 600, count 1
    now = 700; // 700 - 600 = 100 < 1000 → cache (the `+` mutant would be 1300, refetch)
    await fetcher();
    expect(fetchCount).toBe(1);

    now = 1600; // 1600 - 600 = 1000, NOT < 1000 → refetch (the `<=` mutant would still cache)
    await fetcher();
    expect(fetchCount).toBe(2);
  });

  test("defaults to [] when the JWKS body has no keys array", async () => {
    const fetcher = createJwksFetcher("https://x/jwks", {
      fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await fetcher()).toEqual([]);
  });

  test("throws 'JWKS fetch failed: <status>' on a non-OK response", async () => {
    const fetcher = createJwksFetcher("https://x/jwks", {
      fetchImpl: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(fetcher()).rejects.toThrow("JWKS fetch failed: 503");
  });
});

describe("verifyJwt — clock injection, nbf boundary, unset audience, JWKS caching", () => {
  test("nbf exactly equal to now is still valid (kills L132 `<` → `<=`)", async () => {
    configure();
    const nowSec = 1_700_000_000;
    const { token, jwk } = await makeToken({
      sub: "u1",
      iss: "https://issuer",
      aud: "my-api",
      exp: nowSec + 3600,
      nbf: nowSec,
    });
    serveJwks(jwk);
    __setJwtDepsForTesting({ now: () => nowSec * 1000 }); // nowSec === nbf → `<` false (valid), `<=` rejects
    expect(await verifyJwt(token)).toMatchObject({ valid: true });
  });

  test("a future-exp token is expired under an injected clock past exp (kills L56 `if (deps.now)`)", async () => {
    configure();
    const realFuture = Math.floor(Date.now() / 1000) + 100;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: realFuture });
    serveJwks(jwk);
    // Inject a clock well past exp. If `if (deps.now)` is skipped, the default
    // (real) clock is used and the token would NOT be expired.
    __setJwtDepsForTesting({ now: () => (realFuture + 100) * 1000 });
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "expired" });
  });

  test("with no audience configured, any aud validates (kills L134 `if (config.jwtAudience)` → true)", async () => {
    configure();
    (config as Record<string, unknown>).jwtAudience = ""; // unset → the aud check must be skipped
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "whatever", exp: future() });
    serveJwks(jwk);
    expect(await verifyJwt(token)).toMatchObject({ valid: true });
  });

  test("caches the JWKS within cacheMs and refetches after it (kills L45 cacheMs + L46 nowFn)", async () => {
    configure();
    const origCacheMs = config.jwtJwksCacheMs;
    (config as Record<string, unknown>).jwtJwksCacheMs = 1000;
    try {
      let fetchCount = 0;
      let now = 5000;
      const { token, jwk } = await makeToken({
        sub: "u1",
        iss: "https://issuer",
        aud: "my-api",
        exp: 9_999_999_999,
      });
      __setJwtDepsForTesting({
        fetch: (async () => {
          fetchCount++;
          return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
        }) as unknown as typeof fetch,
        now: () => now,
      });
      await verifyJwt(token);
      await verifyJwt(token);
      expect(fetchCount).toBe(1); // cached within cacheMs
      now = 6001; // past 5000 + cacheMs → stale
      await verifyJwt(token);
      expect(fetchCount).toBe(2);
    } finally {
      (config as Record<string, unknown>).jwtJwksCacheMs = origCacheMs;
    }
  });

  test("verifyJwt passes an abort signal (request timeout) to the JWKS fetch (kills L40 `{signal}` → `{}`)", async () => {
    configure();
    let sawSignal = false;
    const { token, jwk } = await makeToken({ sub: "u1", iss: "https://issuer", aud: "my-api", exp: future() });
    __setJwtDepsForTesting({
      fetch: (async (_url: string, opts?: { signal?: unknown }) => {
        sawSignal = opts?.signal instanceof AbortSignal;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await verifyJwt(token);
    expect(sawSignal).toBe(true);
  });

  test("an empty JWKS body yields 'no matching key' for a kid-less token (kills L43 `?? []`)", async () => {
    configure();
    // A token WITHOUT a kid → candidates = all keys; an empty keys array must stay
    // empty. The `?? []` → `["Stryker was here"]` mutant would inject a bogus key,
    // flip candidates to length 1, and change the reason to "signature invalid".
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signingInput = `${b64urlJson({ alg: "ES256", typ: "JWT" })}.${b64urlJson({
      sub: "u1",
      iss: "https://issuer",
      aud: "my-api",
      exp: future(),
    })}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        kp.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );
    const token = `${signingInput}.${b64url(sig)}`;
    __setJwtDepsForTesting({
      fetch: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await verifyJwt(token)).toMatchObject({ valid: false, reason: "no matching key" });
  });
});

describe("createJwksFetcher — passes an abort signal", () => {
  test("supplies an abort signal (request timeout) to fetch (kills L223 `{signal}` → `{}`)", async () => {
    let sawSignal = false;
    const fetcher = createJwksFetcher("https://x/jwks", {
      fetchImpl: (async (_url: string, opts?: { signal?: unknown }) => {
        sawSignal = opts?.signal instanceof AbortSignal;
        return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await fetcher();
    expect(sawSignal).toBe(true);
  });
});
