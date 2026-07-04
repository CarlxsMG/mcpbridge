import { randomBytes } from "node:crypto";
import { getDb } from "./db/connection.js";
import { hashApiKey } from "./security/key-hash.js";
import { getSecretsProvider } from "./secrets/index.js";
import { createMcpKey, revokeMcpKey, type McpKeyScopes } from "./security/mcp-key-store.js";
import { getBundleDetail, type BundleDetail } from "./bundles.js";
import { TOOL_KEY_SEPARATOR } from "./mcp/registry.js";
import { log } from "./logger.js";

/**
 * Shareable, revocable "install this bundle" links.
 *
 * ── Why a token AND an auto-provisioned MCP key ─────────────────────────────
 * The public GET /install/:token route (src/routes/install-links.ts) has to
 * hand a teammate a fully working, copy-paste connection snippet with NO
 * admin-UI login step. That snippet needs a real, usable MCP bearer key — but
 * it must never be a human admin's personal key (see the CRITICAL SECURITY
 * REQUIREMENT in the feature spec). So creating a link:
 *   1. Mints a brand-new MCP API key (via mcp-key-store.createMcpKey) scoped
 *      via `scopes.tools` to exactly the bundle's (client, tool) pairs — the
 *      same composite `client__tool` scope format proxy.ts's isToolInKeyScope
 *      already checks, using this project's existing per-key access-scoping
 *      machinery rather than inventing a bundle-level equivalent.
 *   2. Stores that key's raw secret encrypted at rest via the pluggable
 *      secrets provider (src/secrets/index.ts's getSecretsProvider() — the
 *      built-in local secret-box, AES-256-GCM, by default; HashiCorp Vault
 *      Transit when SECRETS_PROVIDER=vault — the same mechanism
 *      client_upstream_auth already uses to keep a *retrievable* secret out
 *      of plaintext) so the connection snippet can be rebuilt on demand, any
 *      time the link is visited — not just once at creation.
 *   3. Stores the install *token* itself the opposite way: hashed only
 *      (mcp_api_keys' key_hash/key_prefix idiom, SHA-256 via hashApiKey),
 *      exactly like every other bearer credential in this codebase, since the
 *      token is looked up by equality, never needs to be redisplayed.
 * Revoking the link also revokes the provisioned key (mcp-key-store.revokeMcpKey)
 * so the two share one lifecycle, per the feature spec.
 *
 * A bundle with zero tools has nothing safe to scope a key to — mcp-key-store's
 * normalizeScopes() collapses an empty `tools` array to `null` (== unrestricted),
 * which would silently mint a wide-open key. createInstallLink() refuses that
 * case outright (EMPTY_BUNDLE) rather than risk it.
 */

export interface InstallLinkSummary {
  id: number;
  bundleName: string;
  tokenPrefix: string;
  mcpKeyId: number;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface ResolvedInstallLink {
  bundle: BundleDetail;
  /** The auto-provisioned key's raw secret, decrypted for embedding in a connection snippet. Never a human admin's key. */
  mcpApiKey: string;
}

export type InstallLinkMutationError =
  | { code: "BUNDLE_NOT_FOUND"; message: string }
  | { code: "EMPTY_BUNDLE"; message: string }
  | { code: "SECRET_BOX_NOT_CONFIGURED"; message: string }
  | { code: "SECRETS_PROVIDER_ERROR"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "ALREADY_REVOKED"; message: string };

export type CreateInstallLinkResult =
  { ok: true; record: InstallLinkSummary; rawToken: string } | { ok: false; error: InstallLinkMutationError };

export type RevokeInstallLinkResult = { ok: true } | { ok: false; error: InstallLinkMutationError };

interface InstallTokenRow {
  id: number;
  bundle_name: string;
  token_hash: string;
  token_prefix: string;
  mcp_key_id: number;
  mcp_key_secret_enc: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

const SELECT_COLS =
  "id, bundle_name, token_hash, token_prefix, mcp_key_id, mcp_key_secret_enc, created_by, created_at, expires_at, revoked_at, last_used_at";

function rowToSummary(row: InstallTokenRow): InstallLinkSummary {
  return {
    id: row.id,
    bundleName: row.bundle_name,
    tokenPrefix: row.token_prefix,
    mcpKeyId: row.mcp_key_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Generates a new opaque install-link token: `bil_` + 32 random bytes, base64url-encoded. */
function generateRawToken(): string {
  return `bil_${randomBytes(32).toString("base64url")}`;
}

function toolScopesFor(bundle: BundleDetail): McpKeyScopes {
  return { tools: bundle.tools.map((t) => `${t.client}${TOOL_KEY_SEPARATOR}${t.tool}`) };
}

/**
 * Creates a new install link for `bundleName`: mints a bundle-scoped MCP key,
 * generates+stores the install token, and returns the raw token exactly once
 * (never persisted or retrievable again — same "show once" contract as
 * mcp-key-store.createMcpKey).
 */
export async function createInstallLink(
  bundleName: string,
  expiresAt: number | null,
  actor: string,
): Promise<CreateInstallLinkResult> {
  const bundle = getBundleDetail(bundleName);
  if (!bundle) {
    return { ok: false, error: { code: "BUNDLE_NOT_FOUND", message: `Bundle "${bundleName}" not found` } };
  }
  if (bundle.tools.length === 0) {
    return {
      ok: false,
      error: {
        code: "EMPTY_BUNDLE",
        message: "Cannot create an install link for a bundle with no tools — there is nothing safe to scope a key to",
      },
    };
  }
  const secretsProvider = getSecretsProvider();
  if (!secretsProvider.isConfigured()) {
    return {
      ok: false,
      error: { code: "SECRET_BOX_NOT_CONFIGURED", message: "Set SECRET_ENCRYPTION_KEY to create install links" },
    };
  }

  const { record: keyRecord, rawKey } = createMcpKey(
    `install-link:${bundleName}`,
    toolScopesFor(bundle),
    expiresAt,
    actor,
    null,
    false,
  );

  let secretEnc: string;
  try {
    secretEnc = await secretsProvider.encryptSecret(rawKey);
  } catch (err) {
    // The MCP key was already minted above — without a stored, retrievable
    // encrypted secret there is no install-link row to hang it off of, so
    // revoke it rather than leave an orphaned, unused-but-live key behind.
    revokeMcpKey(keyRecord.id);
    return {
      ok: false,
      error: { code: "SECRETS_PROVIDER_ERROR", message: err instanceof Error ? err.message : String(err) },
    };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashApiKey(rawToken);
  const tokenPrefix = rawToken.slice(0, 12);
  const now = Date.now();

  const row = getDb()
    .query(
      `INSERT INTO bundle_install_tokens
         (bundle_name, token_hash, token_prefix, mcp_key_id, mcp_key_secret_enc, created_by, created_at, expires_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       RETURNING ${SELECT_COLS}`,
    )
    .get(bundleName, tokenHash, tokenPrefix, keyRecord.id, secretEnc, actor, now, expiresAt) as InstallTokenRow;

  return { ok: true, record: rowToSummary(row), rawToken };
}

/** Lists install links for a bundle — prefix + timestamps only, never the raw token or the underlying key secret. */
export function listInstallLinks(bundleName: string): InstallLinkSummary[] {
  const rows = getDb()
    .query(`SELECT ${SELECT_COLS} FROM bundle_install_tokens WHERE bundle_name = ? ORDER BY id DESC`)
    .all(bundleName) as InstallTokenRow[];
  return rows.map(rowToSummary);
}

function getInstallLinkRow(bundleName: string, id: number): InstallTokenRow | null {
  if (!Number.isInteger(id)) return null;
  return getDb()
    .query(`SELECT ${SELECT_COLS} FROM bundle_install_tokens WHERE id = ? AND bundle_name = ?`)
    .get(id, bundleName) as InstallTokenRow | null;
}

/**
 * Revokes an install link (soft — sets revoked_at, never hard-deleted, for
 * audit trail) AND revokes its auto-provisioned MCP key in the same call, so
 * the two share one lifecycle exactly as the feature spec requires.
 */
export function revokeInstallLink(bundleName: string, id: number): RevokeInstallLinkResult {
  const row = getInstallLinkRow(bundleName, id);
  if (!row) {
    return { ok: false, error: { code: "NOT_FOUND", message: "Install link not found" } };
  }
  if (row.revoked_at !== null) {
    return { ok: false, error: { code: "ALREADY_REVOKED", message: "Install link is already revoked" } };
  }
  const now = Date.now();
  getDb()
    .query(`UPDATE bundle_install_tokens SET revoked_at = ? WHERE id = ? AND bundle_name = ? AND revoked_at IS NULL`)
    .run(now, id, bundleName);
  // Best-effort — the link row is already revoked above regardless of whether
  // the key was already gone/revoked out of band.
  revokeMcpKey(row.mcp_key_id);
  return { ok: true };
}

/**
 * Revokes every still-active install link for a bundle (and each one's
 * underlying MCP key). Called from the bundle-delete path so deleting a
 * bundle can't strand a bundle-scoped key active forever — ON DELETE CASCADE
 * on `bundle_install_tokens.bundle_name` only removes the link *rows*, it
 * doesn't touch the separately-owned `mcp_api_keys` rows they reference.
 */
export function revokeAllInstallLinksForBundle(bundleName: string): void {
  const rows = getDb()
    .query(`SELECT ${SELECT_COLS} FROM bundle_install_tokens WHERE bundle_name = ? AND revoked_at IS NULL`)
    .all(bundleName) as InstallTokenRow[];
  if (rows.length === 0) return;
  const now = Date.now();
  const txn = getDb().transaction(() => {
    for (const row of rows) {
      getDb().query(`UPDATE bundle_install_tokens SET revoked_at = ? WHERE id = ?`).run(now, row.id);
      revokeMcpKey(row.mcp_key_id);
    }
  });
  txn();
}

/**
 * Resolves a raw install-link token (as presented to GET /install/:token) to
 * the bundle's shareable detail plus its scoped MCP key's raw secret. Returns
 * null for unknown, revoked, or expired tokens — callers should treat any
 * non-null result as "this link is currently valid" and 404 otherwise (never
 * distinguish "unknown token" from "revoked/expired token" in the response).
 * Hashes the incoming token before ever touching SQLite — never a raw-value scan.
 */
export async function resolveInstallLinkToken(rawToken: string): Promise<ResolvedInstallLink | null> {
  if (!rawToken) return null;
  const row = getDb()
    .query(`SELECT ${SELECT_COLS} FROM bundle_install_tokens WHERE token_hash = ?`)
    .get(hashApiKey(rawToken)) as InstallTokenRow | null;
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return null;

  const bundle = getBundleDetail(row.bundle_name);
  if (!bundle) return null; // Bundle was deleted; the row would normally have cascaded away too.

  let mcpApiKey: string;
  try {
    mcpApiKey = await getSecretsProvider().decryptSecret(row.mcp_key_secret_enc);
  } catch (err) {
    log("warn", "Failed to decrypt install-link MCP key — is the secrets provider configured correctly?", {
      installLinkId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  touchInstallLinkLastUsed(row.id);
  return { bundle, mcpApiKey };
}

/** Best-effort update of last_used_at — never throws into the public resolve path. */
function touchInstallLinkLastUsed(id: number): void {
  try {
    getDb().query(`UPDATE bundle_install_tokens SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  } catch {
    // ignore — last-used tracking must never break a valid install-link resolution
  }
}
