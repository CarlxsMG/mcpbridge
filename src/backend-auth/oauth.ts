/**
 * Outbound OAuth2 client-credentials with auto-refresh.
 *
 * A REST client can carry a `client_oauth` config (token endpoint + client id +
 * encrypted client secret + optional scope). Before each proxied call the bridge
 * mints/reuses a short-lived access token from the token endpoint and injects it
 * as `Authorization: Bearer …` — the MCP caller never sees the real credentials
 * (credential-broker pattern). Tokens are cached until shortly before expiry.
 *
 * Extends the at-rest encryption of [secret-box] + the per-client upstream-auth
 * layer. mTLS, AWS SigV4, and explicit secret rotation are follow-on sub-parts.
 */
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { getSecretsProvider } from "../secrets/index.js";
import { validateBackendUrl } from "../security/ip-validator.js";

export interface OAuthPublic {
  tokenUrl: string;
  clientId: string;
  scope: string | null;
}

interface OAuthRow {
  token_url: string;
  client_id: string;
  client_secret_enc: string;
  scope: string | null;
}

/** Read-model (never returns the secret). */
export function getClientOAuth(clientName: string): OAuthPublic | null {
  const row = getDb()
    .query(`SELECT token_url, client_id, scope FROM client_oauth WHERE client_name = ?`)
    .get(clientName) as { token_url: string; client_id: string; scope: string | null } | null;
  return row ? { tokenUrl: row.token_url, clientId: row.client_id, scope: row.scope } : null;
}

export type OAuthError = "CLIENT_NOT_FOUND" | "SECRET_BOX_UNCONFIGURED" | "INVALID_URL" | "SECRETS_PROVIDER_ERROR";

export async function setClientOAuth(
  clientName: string,
  input: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string } | null,
): Promise<{ ok: true } | { ok: false; error: OAuthError; reason?: string }> {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM clients WHERE name = ?`).get(clientName))
    return { ok: false, error: "CLIENT_NOT_FOUND" };
  if (input === null) {
    db.query(`DELETE FROM client_oauth WHERE client_name = ?`).run(clientName);
    tokenCache.delete(clientName);
    return { ok: true };
  }
  const secretsProvider = getSecretsProvider();
  if (!secretsProvider.isConfigured()) return { ok: false, error: "SECRET_BOX_UNCONFIGURED" };
  const check = await validateBackendUrl(input.tokenUrl, config.allowPrivateIps, config.allowedHosts);
  if (!check.valid) return { ok: false, error: "INVALID_URL", reason: check.reason };

  let clientSecretEnc: string;
  try {
    clientSecretEnc = await secretsProvider.encryptSecret(input.clientSecret);
  } catch (err) {
    return { ok: false, error: "SECRETS_PROVIDER_ERROR", reason: err instanceof Error ? err.message : String(err) };
  }

  db.query(
    `INSERT INTO client_oauth (client_name, token_url, client_id, client_secret_enc, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_name) DO UPDATE SET
       token_url = excluded.token_url,
       client_id = excluded.client_id,
       client_secret_enc = excluded.client_secret_enc,
       scope = excluded.scope,
       updated_at = excluded.updated_at`,
  ).run(clientName, input.tokenUrl, input.clientId, clientSecretEnc, input.scope ?? null, Date.now());
  tokenCache.delete(clientName);
  return { ok: true };
}

// ── Token cache + minting ───────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const SKEW_MS = 30_000;
let nowFn: () => number = () => Date.now();
let fetchImpl: typeof fetch = fetch;

export function __setOAuthDepsForTesting(deps: { fetch?: typeof fetch; now?: () => number }): void {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.now) nowFn = deps.now;
}
export function __resetOAuthForTesting(): void {
  tokenCache.clear();
  nowFn = () => Date.now();
  fetchImpl = fetch;
}

/**
 * Returns a valid access token for the client (cached, refreshed shortly before
 * expiry), or null when OAuth isn't configured or the token endpoint failed —
 * in which case the call proceeds without it and the backend decides.
 */
export async function getOAuthBearer(clientName: string): Promise<string | null> {
  const row = getDb()
    .query(`SELECT token_url, client_id, client_secret_enc, scope FROM client_oauth WHERE client_name = ?`)
    .get(clientName) as OAuthRow | null;
  if (!row) return null;

  const now = nowFn();
  const cached = tokenCache.get(clientName);
  if (cached && cached.expiresAt - SKEW_MS > now) return cached.token;

  let secret: string;
  try {
    secret = await getSecretsProvider().decryptSecret(row.client_secret_enc);
  } catch {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: row.client_id,
    client_secret: secret,
  });
  if (row.scope) body.set("scope", row.scope);

  try {
    const resp = await fetchImpl(row.token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(config.oauthTokenTimeoutMs),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (typeof json.access_token !== "string") return null;
    const ttlMs = (typeof json.expires_in === "number" ? json.expires_in : 3600) * 1000;
    tokenCache.set(clientName, { token: json.access_token, expiresAt: now + ttlMs });
    return json.access_token;
  } catch {
    return null;
  }
}
