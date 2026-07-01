import { getDb } from "./db/connection.js";

/** Tags are lowercase, alnum plus - and _, up to 32 chars. */
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

export function getToolTags(clientName: string, toolName: string): string[] {
  return (
    getDb()
      .query(`SELECT tag FROM tool_tags WHERE client_name = ? AND tool_name = ? ORDER BY tag`)
      .all(clientName, toolName) as { tag: string }[]
  ).map((r) => r.tag);
}

/** Replace-all set of a tool's tags. Returns false if the tool doesn't exist. */
export function setToolTags(clientName: string, toolName: string, tags: string[]): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return false;
  const clean = [...new Set(tags.map(normalizeTag).filter((t) => TAG_RE.test(t)))];
  const now = Date.now();
  const txn = db.transaction(() => {
    db.query(`DELETE FROM tool_tags WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    const ins = db.query(`INSERT INTO tool_tags (client_name, tool_name, tag, created_at) VALUES (?, ?, ?, ?)`);
    for (const t of clean) ins.run(clientName, toolName, t, now);
  });
  txn();
  return true;
}

/** All distinct tags with the number of tools carrying each. */
export function listAllTags(): { tag: string; count: number }[] {
  return getDb()
    .query(`SELECT tag, COUNT(*) as count FROM tool_tags GROUP BY tag ORDER BY count DESC, tag`)
    .all() as { tag: string; count: number }[];
}

/** Every (client, tool) carrying a given tag. */
export function listToolsByTag(tag: string): { client: string; tool: string }[] {
  return (
    getDb()
      .query(`SELECT client_name, tool_name FROM tool_tags WHERE tag = ? ORDER BY client_name, tool_name`)
      .all(normalizeTag(tag)) as { client_name: string; tool_name: string }[]
  ).map((r) => ({ client: r.client_name, tool: r.tool_name }));
}

/** Tags for every tool of a client, keyed by tool name — batched for detail views. */
export function getTagsForClient(clientName: string): Record<string, string[]> {
  const rows = getDb()
    .query(`SELECT tool_name, tag FROM tool_tags WHERE client_name = ? ORDER BY tag`)
    .all(clientName) as { tool_name: string; tag: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.tool_name] ??= []).push(r.tag);
  return out;
}

/** Tags for every tool across all clients, keyed by `client__tool`. */
export function getAllToolTags(): Record<string, string[]> {
  const rows = getDb()
    .query(`SELECT client_name, tool_name, tag FROM tool_tags ORDER BY tag`)
    .all() as { client_name: string; tool_name: string; tag: string }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[`${r.client_name}__${r.tool_name}`] ??= []).push(r.tag);
  return out;
}
