import { getDb } from "../db/connection.js";
import { toolExists } from "../lib/tool-config.js";

/** Tags are lowercase, alnum plus - and _, up to 32 chars. */
export const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Replace-all set of a tool's tags. Returns false if the tool doesn't exist. */
export function setToolTags(clientName: string, toolName: string, tags: string[]): boolean {
  if (!toolExists(clientName, toolName)) return false;
  const db = getDb();
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

/**
 * All distinct tags with the number of tools carrying each. When `teamId` is a
 * number the result is scoped to that team's clients (JOIN clients on
 * client_name); super-admin/bearer callers pass undefined for an unfiltered
 * view.
 */
export function listAllTags(teamId?: number): { tag: string; count: number }[] {
  if (teamId === undefined) {
    return getDb()
      .query(`SELECT tag, COUNT(*) as count FROM tool_tags GROUP BY tag ORDER BY count DESC, tag`)
      .all() as {
      tag: string;
      count: number;
    }[];
  }
  return getDb()
    .query(
      `SELECT tag, COUNT(*) as count FROM tool_tags
       JOIN clients ON clients.name = tool_tags.client_name
       WHERE clients.team_id = ?
       GROUP BY tag ORDER BY count DESC, tag`,
    )
    .all(teamId) as { tag: string; count: number }[];
}

/**
 * Every (client, tool) carrying a given tag. When `teamId` is a number the
 * result is scoped to that team's clients; super-admin/bearer callers pass
 * undefined for an unfiltered view.
 */
export function listToolsByTag(tag: string, teamId?: number): { client: string; tool: string }[] {
  const rows =
    teamId === undefined
      ? (getDb()
          .query(`SELECT client_name, tool_name FROM tool_tags WHERE tag = ? ORDER BY client_name, tool_name`)
          .all(normalizeTag(tag)) as { client_name: string; tool_name: string }[])
      : (getDb()
          .query(
            `SELECT tool_tags.client_name AS client_name, tool_tags.tool_name AS tool_name FROM tool_tags
             JOIN clients ON clients.name = tool_tags.client_name
             WHERE tool_tags.tag = ? AND clients.team_id = ?
             ORDER BY tool_tags.client_name, tool_tags.tool_name`,
          )
          .all(normalizeTag(tag), teamId) as { client_name: string; tool_name: string }[]);
  return rows.map((r) => ({ client: r.client_name, tool: r.tool_name }));
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
  const rows = getDb().query(`SELECT client_name, tool_name, tag FROM tool_tags ORDER BY tag`).all() as {
    client_name: string;
    tool_name: string;
    tag: string;
  }[];
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[`${r.client_name}__${r.tool_name}`] ??= []).push(r.tag);
  return out;
}
