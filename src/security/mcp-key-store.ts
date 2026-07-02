import { randomBytes } from "node:crypto";
import { getDb } from "../db/connection.js";
import { hashApiKey } from "./key-hash.js";

/**
 * Key-centric access scoping. `null` means unrestricted (the key may call any
 * enabled tool — matching the behaviour of a legacy env `MCP_API_KEYS` entry).
 * A non-null object grants access only to the listed clients and/or composite
 * `client__tool` keys; anything not listed is denied (fail closed).
 */
export interface McpKeyScopes {
  /** Client names this key may call any tool on. */
  clients?: string[];
  /** Composite `client__tool` keys this key may call. */
  tools?: string[];
}

/** Public shape of a managed MCP API key — never carries the hash or the raw secret. */
export interface McpApiKeyRecord {
  id: number;
  label: string;
  keyPrefix: string;
  consumerId: number | null;
  elevated: boolean;
  scopes: McpKeyScopes | null;
  enabled: boolean;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

interface KeyRow {
  id: number;
  label: string;
  key_prefix: string;
  consumer_id: number | null;
  elevated: number;
  scopes_json: string | null;
  enabled: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

const SELECT_COLS =
  "id, label, key_prefix, consumer_id, elevated, scopes_json, enabled, expires_at, revoked_at, last_used_at, created_at, updated_at, created_by";

function rowToRecord(row: KeyRow): McpApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.key_prefix,
    consumerId: row.consumer_id,
    elevated: row.elevated === 1,
    scopes: row.scopes_json ? (JSON.parse(row.scopes_json) as McpKeyScopes) : null,
    enabled: row.enabled === 1,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

/** Drops empty arrays and collapses an all-empty scopes object to `null` (= unrestricted). */
function normalizeScopes(scopes: McpKeyScopes | null | undefined): McpKeyScopes | null {
  if (!scopes) return null;
  const out: McpKeyScopes = {};
  if (scopes.clients && scopes.clients.length > 0) out.clients = [...new Set(scopes.clients)];
  if (scopes.tools && scopes.tools.length > 0) out.tools = [...new Set(scopes.tools)];
  return Object.keys(out).length > 0 ? out : null;
}

/** Generates a new opaque MCP key: `mcp_` + 32 random bytes, base64url-encoded. */
function generateRawKey(): string {
  return `mcp_${randomBytes(32).toString("base64url")}`;
}

export function createMcpKey(
  label: string,
  scopes: McpKeyScopes | null,
  expiresAt: number | null,
  actor: string | null,
  consumerId: number | null = null,
  elevated = false
): { record: McpApiKeyRecord; rawKey: string } {
  const rawKey = generateRawKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);
  const now = Date.now();
  const norm = normalizeScopes(scopes);
  const row = getDb()
    .query(
      `INSERT INTO mcp_api_keys (label, key_hash, key_prefix, consumer_id, elevated, scopes_json, enabled, expires_at, revoked_at, last_used_at, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?)
       RETURNING ${SELECT_COLS}`
    )
    .get(label, keyHash, keyPrefix, consumerId, elevated ? 1 : 0, norm ? JSON.stringify(norm) : null, expiresAt, now, now, actor) as KeyRow;
  return { record: rowToRecord(row), rawKey };
}

export function listMcpKeys(): McpApiKeyRecord[] {
  const rows = getDb().query(`SELECT ${SELECT_COLS} FROM mcp_api_keys ORDER BY id DESC`).all() as KeyRow[];
  return rows.map(rowToRecord);
}

export function getMcpKey(id: number): McpApiKeyRecord | null {
  if (!Number.isInteger(id)) return null;
  const row = getDb().query(`SELECT ${SELECT_COLS} FROM mcp_api_keys WHERE id = ?`).get(id) as KeyRow | null;
  return row ? rowToRecord(row) : null;
}

export function updateMcpKey(
  id: number,
  updates: { label?: string; enabled?: boolean; expiresAt?: number | null; scopes?: McpKeyScopes | null; consumerId?: number | null; elevated?: boolean }
): McpApiKeyRecord | null {
  const existing = getMcpKey(id);
  if (!existing) return null;
  const label = updates.label ?? existing.label;
  const enabled = updates.enabled ?? existing.enabled;
  const expiresAt = updates.expiresAt !== undefined ? updates.expiresAt : existing.expiresAt;
  const scopes = updates.scopes !== undefined ? normalizeScopes(updates.scopes) : existing.scopes;
  const consumerId = updates.consumerId !== undefined ? updates.consumerId : existing.consumerId;
  const elevated = updates.elevated ?? existing.elevated;
  getDb()
    .query(`UPDATE mcp_api_keys SET label = ?, enabled = ?, expires_at = ?, scopes_json = ?, consumer_id = ?, elevated = ?, updated_at = ? WHERE id = ?`)
    .run(label, enabled ? 1 : 0, expiresAt, scopes ? JSON.stringify(scopes) : null, consumerId, elevated ? 1 : 0, Date.now(), id);
  return getMcpKey(id);
}

/** Marks a key revoked (and disabled). Returns false if it was already revoked or unknown. */
export function revokeMcpKey(id: number): boolean {
  const now = Date.now();
  const result = getDb()
    .query(`UPDATE mcp_api_keys SET revoked_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(now, now, id);
  return result.changes > 0;
}

export function deleteMcpKey(id: number): boolean {
  const result = getDb().query(`DELETE FROM mcp_api_keys WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function hasAnyMcpKeys(): boolean {
  const row = getDb().query(`SELECT 1 FROM mcp_api_keys LIMIT 1`).get() as unknown;
  return row !== null && row !== undefined;
}

/**
 * Resolves a raw bearer token to a *usable* key record, or null. Returns null
 * for unknown, disabled, revoked, or expired keys — so callers can treat a
 * non-null result as "this key is currently valid".
 */
export function resolveMcpKeyByToken(token: string): McpApiKeyRecord | null {
  if (!token) return null;
  const row = getDb().query(`SELECT ${SELECT_COLS} FROM mcp_api_keys WHERE key_hash = ?`).get(hashApiKey(token)) as
    | KeyRow
    | null;
  if (!row) return null;
  const rec = rowToRecord(row);
  if (!rec.enabled || rec.revokedAt !== null) return null;
  if (rec.expiresAt !== null && rec.expiresAt <= Date.now()) return null;
  return rec;
}

/** Best-effort update of last_used_at — never throws into the auth path. */
export function touchMcpKeyLastUsed(id: number): void {
  try {
    getDb().query(`UPDATE mcp_api_keys SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  } catch {
    // ignore — last-used tracking must never break authentication
  }
}

/**
 * Whether a key with the given scopes may call the tool identified by
 * `clientName` / `compositeToolKey` (`client__tool`). Unrestricted (null)
 * scopes always pass; otherwise the client or the exact tool must be listed.
 */
export function isToolInKeyScope(
  scopes: McpKeyScopes | null,
  clientName: string,
  compositeToolKey: string
): boolean {
  if (!scopes) return true;
  if (scopes.clients?.includes(clientName)) return true;
  if (scopes.tools?.includes(compositeToolKey)) return true;
  return false;
}

/**
 * Scope check for a WS-proxy target (no tools, so only the `clients` scope
 * list applies — a ws-proxy target shares the same name namespace as MCP
 * clients, so a key already scoped to it via `clients` works unchanged).
 */
export function isClientInKeyScope(scopes: McpKeyScopes | null, clientName: string): boolean {
  if (!scopes) return true;
  return scopes.clients?.includes(clientName) ?? false;
}
