import { getDb } from "../db/connection.js";
import { encryptSecret, decryptSecret } from "./secret-box.js";
import { log } from "../logger.js";

export type UpstreamAuthType = "bearer" | "basic" | "header";

/** Non-secret view of a client's upstream credential config — safe to return over the admin API. */
export interface UpstreamAuthInfo {
  configured: boolean;
  type?: UpstreamAuthType;
  headerName?: string | null;
  updatedAt?: number;
}

/** The sensitive part of a credential, stored only in encrypted form. */
export type UpstreamSecret =
  | { token: string }
  | { username: string; password: string }
  | { value: string };

interface AuthRow {
  auth_type: string;
  header_name: string | null;
  secret_enc: string;
  updated_at: number;
}

export function getUpstreamAuthInfo(clientName: string): UpstreamAuthInfo {
  const row = getDb()
    .query(`SELECT auth_type, header_name, updated_at FROM client_upstream_auth WHERE client_name = ?`)
    .get(clientName) as { auth_type: string; header_name: string | null; updated_at: number } | null;
  if (!row) return { configured: false };
  return { configured: true, type: row.auth_type as UpstreamAuthType, headerName: row.header_name, updatedAt: row.updated_at };
}

export function setUpstreamAuth(
  clientName: string,
  type: UpstreamAuthType,
  secret: UpstreamSecret,
  headerName: string | null
): void {
  const enc = encryptSecret(JSON.stringify(secret));
  getDb()
    .query(
      `INSERT INTO client_upstream_auth (client_name, auth_type, header_name, secret_enc, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(client_name) DO UPDATE SET
         auth_type = excluded.auth_type,
         header_name = excluded.header_name,
         secret_enc = excluded.secret_enc,
         updated_at = excluded.updated_at`
    )
    .run(clientName, type, headerName, enc, Date.now());
}

export function clearUpstreamAuth(clientName: string): boolean {
  return getDb().query(`DELETE FROM client_upstream_auth WHERE client_name = ?`).run(clientName).changes > 0;
}

/**
 * Resolves the outbound headers to inject when the proxy calls this client's
 * upstream. Returns null when no credential is configured, or when decryption
 * fails (e.g. the encryption key changed) — in which case the request proceeds
 * unauthenticated and the upstream's own auth error surfaces to the caller.
 */
export function getUpstreamAuthHeaders(clientName: string): Record<string, string> | null {
  const row = getDb()
    .query(`SELECT auth_type, header_name, secret_enc, updated_at FROM client_upstream_auth WHERE client_name = ?`)
    .get(clientName) as AuthRow | null;
  if (!row) return null;

  let secret: Record<string, string>;
  try {
    secret = JSON.parse(decryptSecret(row.secret_enc)) as Record<string, string>;
  } catch {
    log("warn", "Failed to decrypt upstream auth — is SECRET_ENCRYPTION_KEY correct?", { client: clientName });
    return null;
  }

  switch (row.auth_type) {
    case "bearer":
      return secret.token ? { Authorization: `Bearer ${secret.token}` } : null;
    case "basic":
      return secret.username !== undefined && secret.password !== undefined
        ? { Authorization: `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString("base64")}` }
        : null;
    case "header":
      return row.header_name && secret.value !== undefined ? { [row.header_name]: secret.value } : null;
    default:
      return null;
  }
}
