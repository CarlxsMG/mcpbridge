/**
 * SSO login for the admin UI: OIDC Authorization Code + PKCE (explicitly OIDC
 * only, never SAML — hand-rolling SAML's XML-DSig verification without a
 * vetted library is a real auth-bypass risk class).
 *
 * Reuses this codebase's existing JWKS-fetch + RS256/ES256 signature-
 * verification machinery (src/security/jwt.ts's `createJwksFetcher` /
 * `verifyJwtSignatureWithKeys`) for ID-token verification rather than
 * reimplementing JWT/JWKS handling — this module only adds the OIDC-specific
 * pieces on top: discovery, PKCE, the token exchange, iss/aud/exp checks
 * against the *configured provider* (not the global JWT_JWKS_URL config), and
 * the state/PKCE nonce store.
 *
 * The issuer URL is operator/admin-configured infrastructure (like a Vault
 * address or OTEL_EXPORTER_OTLP_ENDPOINT), not a per-tenant registered
 * backend — it deliberately does NOT go through the resolved-IP-pinning SSRF
 * defense that applies to user-registered health_url/base_url/openapi_url.
 *
 * SECURITY-CRITICAL: auto-provisioning (see `findOrProvisionSsoUser`) always
 * assigns the 'viewer' role, full stop — never anything configurable. See
 * migration 50's oidc_config.default_role CHECK constraint and the comment
 * on that function for why.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "../db/connection.js";
import { getSecretsProvider } from "../secrets/index.js";
import { log } from "../logger.js";
import { createUser, findUserByUsername, findUserById, type AdminUser } from "./user-store.js";
import { createJwksFetcher, verifyJwtSignatureWithKeys, type JwtClaims, type Jwk } from "./jwt.js";
import { sha256Hex } from "../lib/crypto.js";
import { createTtlCache } from "../lib/ttl-cache.js";
import { errorMessage } from "../lib/error-message.js";

// ── WebCrypto-based PKCE (RFC 7636) ─────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generates a high-entropy code_verifier and its S256 code_challenge, both via WebCrypto. */
export async function generatePkcePair(): Promise<PkcePair> {
  const codeVerifier = b64url(randomBytes(32)); // 43 chars — within RFC 7636's 43-128 char range
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = b64url(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

// ── Injectable deps (fetch + clock), mirroring jwt.ts's testing hooks ──────

let fetchImpl: typeof fetch = fetch;
let nowFn: () => number = () => Date.now();
// discoveryTtlCache (declared below, alongside its fetch function) caches the
// discovery document itself; this tracks which issuer it was last fetched
// for, since createTtlCache's `arg` is only plumbed through to fetchFn on a
// miss and never gates freshness itself — a *different* issuer must force a
// reset() rather than silently reuse another issuer's still-fresh document.
let discoveryCacheIssuer: string | null = null;
const jwksFetchers = new Map<string, () => Promise<Jwk[]>>();

export function __setOidcDepsForTesting(deps: { fetch?: typeof fetch; now?: () => number }): void {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.now) nowFn = deps.now;
}
export function __resetOidcForTesting(): void {
  fetchImpl = fetch;
  nowFn = () => Date.now();
  discoveryCacheIssuer = null;
  discoveryTtlCache.reset();
  jwksFetchers.clear();
}

const DISCOVERY_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 5_000;
const DISCOVERY_CACHE_MS = 600_000;
/** How long a PKCE code_verifier waits server-side for its callback — an interactive login round trip is seconds, not minutes, but this leaves headroom for a slow IdP consent screen. */
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

// ── Discovery ────────────────────────────────────────────────────────────

export interface OidcDiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer?: string;
}

const discoveryTtlCache = createTtlCache<OidcDiscoveryDocument, string>(
  async (issuer) => {
    const base = issuer.replace(/\/+$/, "");
    const resp = await fetchImpl(`${base}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`OIDC discovery fetch failed: HTTP ${resp.status}`);
    const doc = (await resp.json()) as OidcDiscoveryDocument;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error("OIDC discovery document is missing a required endpoint");
    }
    return doc;
  },
  DISCOVERY_CACHE_MS,
  { nowFn: () => nowFn() },
);

/** Fetches (and caches) `{issuer}/.well-known/openid-configuration` — never a hardcoded path guess. */
export async function discoverOidcIssuer(issuer: string): Promise<OidcDiscoveryDocument> {
  if (discoveryCacheIssuer !== issuer) {
    discoveryTtlCache.reset();
    discoveryCacheIssuer = issuer;
  }
  return discoveryTtlCache.get(issuer);
}

function getJwksFetcherFor(jwksUri: string): () => Promise<Jwk[]> {
  let f = jwksFetchers.get(jwksUri);
  if (!f) {
    f = createJwksFetcher(jwksUri, { fetchImpl, timeoutMs: DISCOVERY_TIMEOUT_MS, nowFn });
    jwksFetchers.set(jwksUri, f);
  }
  return f;
}

// ── ID-token verification (signature via jwt.ts, then OIDC-specific claims) ─

export type IdTokenVerifyResult = { valid: true; claims: JwtClaims } | { valid: false; reason: string };

/** Verifies an ID token's signature (via jwt.ts's shared JWKS machinery) plus its iss/aud/exp claims. */
export async function verifyIdToken(
  idToken: string,
  opts: { issuer: string; audience: string; jwksUri: string },
): Promise<IdTokenVerifyResult> {
  let keys: Jwk[];
  try {
    keys = await getJwksFetcherFor(opts.jwksUri)();
  } catch (e) {
    return { valid: false, reason: `jwks: ${errorMessage(e)}` };
  }
  const sig = await verifyJwtSignatureWithKeys(idToken, keys);
  if (!sig.valid) return sig;

  const claims = sig.claims;
  const nowSec = Math.floor(nowFn() / 1000);
  if (typeof claims.exp !== "number" || nowSec >= claims.exp) return { valid: false, reason: "expired" };
  if (typeof claims.nbf === "number" && nowSec < claims.nbf) return { valid: false, reason: "not yet valid" };
  if (claims.iss !== opts.issuer) return { valid: false, reason: "issuer mismatch" };
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(opts.audience)) return { valid: false, reason: "audience mismatch" };
  return { valid: true, claims };
}

// ── Token exchange ──────────────────────────────────────────────────────────

export interface OidcTokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Server-side POST to the token endpoint — the client secret never reaches the browser. */
export async function exchangeAuthorizationCode(
  tokenEndpoint: string,
  params: { code: string; redirectUri: string; clientId: string; clientSecret: string; codeVerifier: string },
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });
  const resp = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`OIDC token exchange failed: HTTP ${resp.status}`);
  return (await resp.json()) as OidcTokenResponse;
}

// ── State/PKCE nonce store (oidc_auth_state) ────────────────────────────────
//
// `state` is itself the random, unguessable primary key — also sent to the
// IdP as the OAuth `state` param, so a valid callback can only ever present a
// value this server generated and hasn't already consumed (server-side,
// unforgeable — never an unsigned cookie). Cleaned up opportunistically on
// every read/write, mirroring this codebase's existing lazy-expiry idiom for
// other TTL'd state (e.g. src/db/rate-counters.ts's window pruning).

function cleanupExpiredAuthState(now: number): void {
  getDb().query(`DELETE FROM oidc_auth_state WHERE expires_at < ?`).run(now);
}

/** Persists a PKCE code_verifier keyed by a fresh random state value; returns that state. */
export function createOidcAuthState(codeVerifier: string): string {
  const now = nowFn();
  cleanupExpiredAuthState(now);
  const state = b64url(randomBytes(32));
  getDb()
    .query(`INSERT INTO oidc_auth_state (state, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(state, codeVerifier, now, now + OIDC_STATE_TTL_MS);
  return state;
}

/**
 * Validates + single-use-consumes a state value. Missing, expired, and
 * already-used states all return null and are treated identically by
 * callers — never reveal which case it was. The row is deleted on every
 * lookup attempt (valid or not) so a leaked/replayed state value can never be
 * consumed twice.
 */
export function consumeOidcAuthState(state: string): string | null {
  const now = nowFn();
  cleanupExpiredAuthState(now);
  const row = getDb().query(`SELECT code_verifier, expires_at FROM oidc_auth_state WHERE state = ?`).get(state) as {
    code_verifier: string;
    expires_at: number;
  } | null;
  getDb().query(`DELETE FROM oidc_auth_state WHERE state = ?`).run(state);
  if (!row || row.expires_at < now) return null;
  return row.code_verifier;
}

// ── oidc_config CRUD ─────────────────────────────────────────────────────────

export interface OidcPublicConfig {
  enabled: boolean;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  enabled: boolean;
  defaultRole: "viewer";
  updatedAt: number;
}

/** Internal read-model (the only one carrying the encrypted secret ref) — used by the /callback handler. */
export interface OidcConfigInternal extends OidcSettings {
  clientSecretRef: string;
}

interface OidcConfigRow {
  id: number;
  issuer: string;
  client_id: string;
  client_secret_ref: string;
  redirect_uri: string;
  scopes: string;
  enabled: number;
  default_role: string;
  created_at: number;
  updated_at: number;
}

function getConfigRow(): OidcConfigRow | null {
  return getDb().query(`SELECT * FROM oidc_config WHERE id = 1`).get() as OidcConfigRow | null;
}

function rowToSettings(row: OidcConfigRow): OidcSettings {
  return {
    issuer: row.issuer,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    enabled: row.enabled === 1,
    // The DB CHECK constraint guarantees this can only ever be 'viewer' (v1) —
    // see migration 50 and findOrProvisionSsoUser()'s doc comment.
    defaultRole: "viewer",
    updatedAt: row.updated_at,
  };
}

/** PUBLIC, pre-auth read-model for the login page: only whether SSO is available. Never leaks issuer/client id/etc. */
export function getOidcPublicConfig(): OidcPublicConfig {
  const row = getConfigRow();
  return { enabled: row !== null && row.enabled === 1 };
}

/** Superadmin settings read-model — everything except the secret (write-only; never re-populated). */
export function getOidcSettings(): OidcSettings | null {
  const row = getConfigRow();
  return row ? rowToSettings(row) : null;
}

/** Internal read-model (proxy/callback dispatch) — includes the encrypted client_secret_ref. */
export function getOidcConfigInternal(): OidcConfigInternal | null {
  const row = getConfigRow();
  return row ? { ...rowToSettings(row), clientSecretRef: row.client_secret_ref } : null;
}

export type OidcConfigError = "VALIDATION_ERROR" | "SECRETS_PROVIDER_UNCONFIGURED" | "SECRETS_PROVIDER_ERROR";

export interface OidcConfigInput {
  issuer: string;
  clientId: string;
  /** Raw secret — always required on write, matching context-budget.ts's write-only-secret convention (no "keep existing" partial update). */
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  enabled: boolean;
}

/** Upserts the (single-row) OIDC config. The client secret is one-way-encrypted via the pluggable secrets provider and never echoed back. */
export async function setOidcConfig(
  input: OidcConfigInput,
): Promise<{ ok: true } | { ok: false; error: OidcConfigError; reason: string }> {
  const issuer = input.issuer.trim().replace(/\/+$/, "");
  const clientId = input.clientId.trim();
  const redirectUri = input.redirectUri.trim();
  const scopes = input.scopes.trim() || "openid profile email";
  const clientSecret = input.clientSecret;

  if (!issuer || !/^https:\/\//.test(issuer)) {
    return { ok: false, error: "VALIDATION_ERROR", reason: "issuer must be an https:// URL" };
  }
  if (!clientId) return { ok: false, error: "VALIDATION_ERROR", reason: "clientId is required" };
  if (!redirectUri || !/^https?:\/\//.test(redirectUri)) {
    return { ok: false, error: "VALIDATION_ERROR", reason: "redirectUri must be an http(s) URL" };
  }
  if (!scopes.split(/\s+/).includes("openid")) {
    return { ok: false, error: "VALIDATION_ERROR", reason: "scopes must include 'openid'" };
  }
  if (!clientSecret) return { ok: false, error: "VALIDATION_ERROR", reason: "clientSecret is required" };

  const secretsProvider = getSecretsProvider();
  if (!secretsProvider.isConfigured()) {
    return { ok: false, error: "SECRETS_PROVIDER_UNCONFIGURED", reason: "no secrets provider is configured" };
  }

  let clientSecretRef: string;
  try {
    clientSecretRef = await secretsProvider.encryptSecret(clientSecret);
  } catch (err) {
    return { ok: false, error: "SECRETS_PROVIDER_ERROR", reason: errorMessage(err) };
  }

  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO oidc_config (id, issuer, client_id, client_secret_ref, redirect_uri, scopes, enabled, default_role, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'viewer', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         issuer = excluded.issuer,
         client_id = excluded.client_id,
         client_secret_ref = excluded.client_secret_ref,
         redirect_uri = excluded.redirect_uri,
         scopes = excluded.scopes,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(issuer, clientId, clientSecretRef, redirectUri, scopes, input.enabled ? 1 : 0, now, now);

  discoveryTtlCache.reset(); // issuer may have changed
  discoveryCacheIssuer = null;
  return { ok: true };
}

// ── Identity mapping + auto-provisioning ────────────────────────────────────

function findIdentityUserId(provider: string, subject: string): number | null {
  const row = getDb()
    .query(`SELECT user_id FROM admin_user_identities WHERE provider = ? AND subject = ?`)
    .get(provider, subject) as { user_id: number } | null;
  return row ? row.user_id : null;
}

function linkIdentity(provider: string, subject: string, userId: number): void {
  getDb()
    .query(`INSERT INTO admin_user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(provider, subject, userId, Date.now());
}

function shortSubjectHash(subject: string): string {
  return sha256Hex(subject).slice(0, 8);
}

function slugifyLocalPart(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return cleaned || "user";
}

/** Derives a human-readable, unique username. Never attaches to a pre-existing (possibly unrelated) account on collision. */
function deriveUsername(provider: string, subject: string, claims: JwtClaims): string {
  const emailClaim = typeof claims.email === "string" ? claims.email : null;
  const base = emailClaim ? slugifyLocalPart(emailClaim.split("@")[0]) : `sso-${shortSubjectHash(subject)}`;
  if (!findUserByUsername(base)) return base;
  return `${base}-${provider}-${shortSubjectHash(subject)}`;
}

/**
 * Looks up the admin_users row for (provider, subject), auto-provisioning a
 * brand-new one on first login.
 *
 * SECURITY-CRITICAL: the auto-provisioned role is hard-coded to 'viewer'
 * below — NEVER read from oidc_config.default_role or any other configurable
 * source for the actual grant, even though the schema carries a
 * `default_role` column (constrained by a DB CHECK to only ever be 'viewer'
 * in this v1 — see migration 50). An admin must manually promote a new SSO
 * user after reviewing them; letting first-login auto-provisioning default to
 * 'admin' or any elevated role would let anyone who can complete the IdP's
 * login flow hand themselves admin access to this bridge.
 */
export async function findOrProvisionSsoUser(provider: string, subject: string, claims: JwtClaims): Promise<AdminUser> {
  const existingUserId = findIdentityUserId(provider, subject);
  if (existingUserId !== null) {
    const existing = findUserById(existingUserId);
    if (existing) return existing;
  }

  const username = deriveUsername(provider, subject, claims);
  // Random, never-surfaced password — SSO users authenticate via the IdP
  // only; this just satisfies admin_users.password_hash NOT NULL with a hash
  // nobody can ever produce a matching plaintext for.
  const passwordHash = await Bun.password.hash(randomBytes(32).toString("base64url"));
  const user = createUser(username, passwordHash, "viewer", `oidc:${provider}`);
  linkIdentity(provider, subject, user.id);
  log("info", "Auto-provisioned admin user from SSO login", { username, provider, role: "viewer" });
  return user;
}
