import { getDb } from "./db/connection.js";

export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Redacts a dot-path in place. A `*` segment matches every element of an array
 * or every value of an object. A leaf match replaces the value with the
 * placeholder; missing paths are ignored.
 */
function redactInPlace(node: unknown, segments: string[]): void {
  if (segments.length === 0 || node === null || typeof node !== "object") return;
  const [head, ...rest] = segments;

  if (head === "*") {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (rest.length === 0) node[i] = REDACTION_PLACEHOLDER;
        else redactInPlace(node[i], rest);
      }
    } else {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (rest.length === 0) obj[k] = REDACTION_PLACEHOLDER;
        else redactInPlace(obj[k], rest);
      }
    }
    return;
  }

  if (Array.isArray(node)) return; // a named segment can't index an array
  const obj = node as Record<string, unknown>;
  if (rest.length === 0) {
    if (Object.prototype.hasOwnProperty.call(obj, head)) obj[head] = REDACTION_PLACEHOLDER;
  } else if (obj[head] !== undefined) {
    redactInPlace(obj[head], rest);
  }
}

/**
 * Parses `text` as JSON, redacts the given dot-paths, and returns pretty JSON.
 * Returns null when the text isn't JSON so the caller can fall back to raw.
 */
export function applyRedaction(paths: string[], text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  for (const p of paths) redactInPlace(data, p.split("."));
  return JSON.stringify(data, null, 2);
}

export function getRedactionPaths(clientName: string, toolName: string): string[] {
  const row = getDb()
    .query(`SELECT paths_json FROM tool_redactions WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { paths_json: string } | null;
  return row ? (JSON.parse(row.paths_json) as string[]) : [];
}

/** Replace-all set of a tool's redaction paths. Empty clears. Returns false if the tool doesn't exist. */
export function setRedactionPaths(clientName: string, toolName: string, paths: string[]): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
  const clean = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (clean.length === 0) {
    db.query(`DELETE FROM tool_redactions WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
  } else {
    db.query(
      `INSERT INTO tool_redactions (client_name, tool_name, paths_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET paths_json = excluded.paths_json, updated_at = excluded.updated_at`
    ).run(clientName, toolName, JSON.stringify(clean), Date.now());
  }
  return true;
}

/** Redaction paths for every tool of a client, keyed by tool name (batched for detail views). */
export function getRedactionForClient(clientName: string): Record<string, string[]> {
  const rows = getDb()
    .query(`SELECT tool_name, paths_json FROM tool_redactions WHERE client_name = ?`)
    .all(clientName) as { tool_name: string; paths_json: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) out[r.tool_name] = JSON.parse(r.paths_json) as string[];
  return out;
}
