/**
 * Inbound JWT verification against a JWKS endpoint — dependency-free (WebCrypto).
 *
 * Optional: enabled only when `JWT_JWKS_URL` is set. Lets an MCP caller present a
 * short-lived OAuth2/OIDC access token (RS256 or ES256) instead of a static/managed
 * API key. Keys are fetched from the JWKS URL and cached; signature is verified
 * with `crypto.subtle`, then exp/nbf/iss/aud claims are checked. This is an
 * ADDITIONAL accepted credential in `mcpAuth`, never a replacement — env keys and
 * DB-managed keys keep working unchanged.
 */
import { config } from "../config.js";

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [k: string]: unknown;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
let fetchImpl: typeof fetch = fetch;
let nowFn: () => number = () => Date.now();

/** True when inbound JWT auth is configured. */
export function isJwtConfigured(): boolean {
  return !!config.jwtJwksUrl;
}

export function __setJwtDepsForTesting(deps: { fetch?: typeof fetch; now?: () => number }): void {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.now) nowFn = deps.now;
}
export function __resetJwtForTesting(): void {
  jwksCache = null;
  fetchImpl = fetch;
  nowFn = () => Date.now();
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function getJwks(): Promise<Jwk[]> {
  const now = nowFn();
  if (jwksCache && now - jwksCache.fetchedAt < config.jwtJwksCacheMs) return jwksCache.keys;
  const resp = await fetchImpl(config.jwtJwksUrl as string, { signal: AbortSignal.timeout(config.jwtJwksTimeoutMs) });
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

export function importKey(jwk: Jwk, alg: "RS256" | "ES256"): Promise<CryptoKey> {
  const params =
    alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, params, false, ["verify"]);
}

export type JwtResult = { valid: true; claims: JwtClaims } | { valid: false; reason: string };

/** Verifies a JWT's signature (RS256/ES256) via JWKS, then its exp/nbf/iss/aud. */
export async function verifyJwt(token: string): Promise<JwtResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "not a JWT" };

  let header: { alg?: string; kid?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    claims = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") return { valid: false, reason: `unsupported alg ${String(alg)}` };

  let keys: Jwk[];
  try {
    keys = await getJwks();
  } catch (e) {
    return { valid: false, reason: `jwks: ${e instanceof Error ? e.message : String(e)}` };
  }
  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (candidates.length === 0) return { valid: false, reason: "no matching key" };

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]);
  const verifyAlg = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };

  let signatureOk = false;
  for (const jwk of candidates) {
    try {
      const key = await importKey(jwk, alg);
      if (await crypto.subtle.verify(verifyAlg, key, sig as BufferSource, data as BufferSource)) {
        signatureOk = true;
        break;
      }
    } catch {
      // try the next candidate key
    }
  }
  if (!signatureOk) return { valid: false, reason: "signature invalid" };

  const nowSec = Math.floor(nowFn() / 1000);
  if (typeof claims.exp === "number" && nowSec >= claims.exp) return { valid: false, reason: "expired" };
  if (typeof claims.nbf === "number" && nowSec < claims.nbf) return { valid: false, reason: "not yet valid" };
  if (config.jwtIssuer && claims.iss !== config.jwtIssuer) return { valid: false, reason: "issuer mismatch" };
  if (config.jwtAudience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(config.jwtAudience)) return { valid: false, reason: "audience mismatch" };
  }
  return { valid: true, claims };
}

// ── Reusable JWKS-fetch + JWT-signature-verification building blocks ────────
//
// verifyJwt() above is a single-issuer verifier wired to the globally
// configured JWT_JWKS_URL/JWT_ISSUER/JWT_AUDIENCE, with its own module-level
// cache — left completely untouched so its existing tests keep exercising
// byte-identical behavior. The pieces below factor out the same "fetch a
// JWKS, verify an RS256/ES256 signature" work for callers that need to verify
// against a DIFFERENT, dynamically-configured issuer (OIDC ID-token
// verification against an admin-configured IdP — see src/security/oidc.ts),
// so that code reuses this instead of reimplementing JWT/JWKS handling.

export interface JwtHeader {
  alg?: string;
  kid?: string;
}

export type JwtSignatureResult =
  { valid: true; claims: JwtClaims; header: JwtHeader } | { valid: false; reason: string };

/**
 * Verifies a compact JWT's signature (RS256/ES256) against a caller-supplied
 * JWKS key set. Deliberately does NOT check exp/nbf/iss/aud — those are
 * provider-specific; the caller checks them against whichever issuer/audience
 * it expects (verifyJwt() above checks config.jwtIssuer/jwtAudience; OIDC
 * ID-token verification checks the configured provider's issuer/client_id).
 */
export async function verifyJwtSignatureWithKeys(token: string, keys: Jwk[]): Promise<JwtSignatureResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "not a JWT" };

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    claims = JSON.parse(b64urlToString(parts[1]));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") return { valid: false, reason: `unsupported alg ${String(alg)}` };

  const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (candidates.length === 0) return { valid: false, reason: "no matching key" };

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlToBytes(parts[2]);
  const verifyAlg = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };

  for (const jwk of candidates) {
    try {
      const key = await importKey(jwk, alg);
      if (await crypto.subtle.verify(verifyAlg, key, sig as BufferSource, data as BufferSource)) {
        return { valid: true, claims, header };
      }
    } catch {
      // try the next candidate key
    }
  }
  return { valid: false, reason: "signature invalid" };
}

/**
 * Factory for a cached, injectable JWKS fetcher bound to a single URL — for
 * callers that need to fetch/cache a specific issuer's JWKS rather than the
 * single globally-configured `JWT_JWKS_URL`. Each call returns an
 * independent cache, so fetchers for different issuers never share stale
 * keys, and tests can inject their own `fetchImpl`/`nowFn` exactly like
 * `__setJwtDepsForTesting` does for the module-level verifyJwt() above.
 */
export function createJwksFetcher(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; cacheMs?: number; nowFn?: () => number } = {},
): () => Promise<Jwk[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cacheMs = opts.cacheMs ?? 600_000;
  const now = opts.nowFn ?? (() => Date.now());
  let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

  return async () => {
    const t = now();
    if (cache && t - cache.fetchedAt < cacheMs) return cache.keys;
    const resp = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
    const body = (await resp.json()) as { keys?: Jwk[] };
    cache = { keys: body.keys ?? [], fetchedAt: t };
    return cache.keys;
  };
}
