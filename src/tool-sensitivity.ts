import { getDb } from "./db/connection.js";
import { config } from "./config.js";

/**
 * Per-tool "sensitive" flag governing destructive-action gating. Tri-state:
 *   - explicit true/false (admin set) — always wins
 *   - null (no row) — falls back to config.autoGateWriteMethods for DELETE/PUT
 */
export function getToolSensitivity(clientName: string, toolName: string): boolean | null {
  const row = getDb()
    .query(`SELECT sensitive FROM tool_sensitivity WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { sensitive: number } | null;
  return row ? row.sensitive === 1 : null;
}

/** Sets or (with null) clears the explicit sensitivity flag. Returns false if the tool doesn't exist. */
export function setToolSensitive(clientName: string, toolName: string, sensitive: boolean | null): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
  if (sensitive === null) {
    db.query(`DELETE FROM tool_sensitivity WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
  } else {
    db.query(
      `INSERT INTO tool_sensitivity (client_name, tool_name, sensitive, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET sensitive = excluded.sensitive, updated_at = excluded.updated_at`
    ).run(clientName, toolName, sensitive ? 1 : 0, Date.now());
  }
  return true;
}

/** Effective sensitivity: explicit flag if set, else the config auto-gate for write methods. */
export function isToolSensitive(clientName: string, toolName: string, method: string): boolean {
  const explicit = getToolSensitivity(clientName, toolName);
  if (explicit !== null) return explicit;
  return config.autoGateWriteMethods && (method === "DELETE" || method === "PUT");
}

/** Explicit sensitivity flags for a client's tools, keyed by tool name (batched for detail views). */
export function getSensitivityForClient(clientName: string): Record<string, boolean> {
  const rows = getDb()
    .query(`SELECT tool_name, sensitive FROM tool_sensitivity WHERE client_name = ?`)
    .all(clientName) as { tool_name: string; sensitive: number }[];
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.tool_name] = r.sensitive === 1;
  return out;
}
