import { getDb } from "../../db/connection.js";
import { notifyToolsChanged } from "../../mcp/mcp-server.js";
import { TOOL_KEY_SEPARATOR } from "../../mcp/registry.js";
import { log } from "../../logger.js";
import { TOOL_NAME_RE } from "../../lib/identifier.js";
import { createKeyedMutex, reloadLiveCache } from "../../lib/async-lock.js";

export interface BundleToolRef {
  client: string;
  tool: string;
}

export interface BundleSummary {
  name: string;
  description: string | null;
  enabled: boolean;
  toolsCount: number;
}

export interface BundleDetail {
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  tools: BundleToolRef[];
}

export type BundleMutationError =
  | { code: "INVALID_NAME"; message: string }
  | { code: "ALREADY_EXISTS"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "UNKNOWN_TOOL"; message: string };

export type BundleMutationResult = { ok: true } | { ok: false; error: BundleMutationError };

interface LiveBundle {
  enabled: boolean;
  toolKeys: Set<string>;
}

/**
 * Hot-path cache for MCP resolution (tools/list, tools/call membership
 * checks): name -> {enabled, toolKeys}. Unlike registry.ts's `clients` map,
 * which only gains entries when a backend calls POST /register, bundles have
 * no external "registering" actor — they're purely admin-authored — so this
 * cache is loaded from SQLite once at boot via initBundles() and kept in
 * sync on every admin mutation below.
 */
const liveBundles = new Map<string, LiveBundle>();

// Per-bundle-name async mutex (see lib/async-lock.ts's createKeyedMutex,
// which shares this exact shape with registry.ts's withLock), so concurrent
// admin mutations against the same bundle serialise the same way concurrent
// client mutations already do.
const { withLock } = createKeyedMutex();

function toolKey(client: string, tool: string): string {
  return `${client}${TOOL_KEY_SEPARATOR}${tool}`;
}

function dedupeToolRefs(tools: BundleToolRef[]): BundleToolRef[] {
  const seen = new Set<string>();
  const result: BundleToolRef[] = [];
  for (const t of tools) {
    const key = toolKey(t.client, t.tool);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result;
}

/**
 * Validates that every (client, tool) pair currently exists in the `tools`
 * table. Existence, not "enabled" — a bundle may reference a tool belonging
 * to a currently-down client; it just drops out of tools/list until that
 * client is live again, the same graceful-degradation behaviour the sharded
 * /mcp/:clientName endpoint already has for a single disabled tool.
 */
function findUnknownTool(db: ReturnType<typeof getDb>, tools: BundleToolRef[]): BundleToolRef | undefined {
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`);
  return tools.find((t) => !exists.get(t.client, t.tool));
}

// ---------------------------------------------------------------------------
// Boot + hot-path reads (used by mcp-server.ts / transports.ts)
// ---------------------------------------------------------------------------

/** Loads every bundle from SQLite into the hot-path cache. Call once at boot, after migrations have run. */
export function initBundles(): void {
  const db = getDb();
  const bundleRows = db.query(`SELECT name, enabled FROM mcp_bundles`).all() as { name: string; enabled: number }[];
  const toolRows = db.query(`SELECT bundle_name, client_name, tool_name FROM mcp_bundle_tools`).all() as {
    bundle_name: string;
    client_name: string;
    tool_name: string;
  }[];
  const count = reloadLiveCache(liveBundles, (cache) => {
    for (const row of bundleRows) {
      cache.set(row.name, { enabled: row.enabled === 1, toolKeys: new Set() });
    }
    for (const row of toolRows) {
      cache.get(row.bundle_name)?.toolKeys.add(toolKey(row.client_name, row.tool_name));
    }
  });
  log("info", "Loaded MCP bundles", { count });
}

/** Whether an enabled bundle named `name` exists. False for both "unknown" and "disabled". */
export function isBundleEnabled(name: string): boolean {
  return liveBundles.get(name)?.enabled === true;
}

/**
 * Returns the bundle's tool-key set (composite `clientName__toolName`), or
 * undefined when the bundle doesn't exist. Existence check for session
 * admission — mirrors registry.getClient()'s undefined-means-unknown
 * contract, deliberately independent of `enabled` (a disabled bundle still
 * "exists": sessions may open against it, same as a disabled client, but
 * tools/list returns empty and tools/call is rejected).
 */
export function getBundleToolKeys(name: string): Set<string> | undefined {
  return liveBundles.get(name)?.toolKeys;
}

// ---------------------------------------------------------------------------
// Admin CRUD — SQLite is authoritative; liveBundles is refreshed after every
// mutation so the MCP-serving hot path never re-reads SQL per call.
// ---------------------------------------------------------------------------

export function listBundles(): BundleSummary[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT b.name, b.description, b.enabled, COUNT(t.client_name) as tools_count
       FROM mcp_bundles b LEFT JOIN mcp_bundle_tools t ON t.bundle_name = b.name
       GROUP BY b.name
       ORDER BY b.name`,
    )
    .all() as { name: string; description: string | null; enabled: number; tools_count: number }[];
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    enabled: r.enabled === 1,
    toolsCount: r.tools_count,
  }));
}

export function getBundleDetail(name: string): BundleDetail | undefined {
  const db = getDb();
  const row = db
    .query(`SELECT name, description, enabled, created_at, updated_at FROM mcp_bundles WHERE name = ?`)
    .get(name) as {
    name: string;
    description: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
  } | null;
  if (!row) return undefined;

  const toolRows = db
    .query(`SELECT client_name, tool_name FROM mcp_bundle_tools WHERE bundle_name = ? ORDER BY client_name, tool_name`)
    .all(name) as { client_name: string; tool_name: string }[];

  return {
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tools: toolRows.map((t) => ({ client: t.client_name, tool: t.tool_name })),
  };
}

export async function createBundle(
  name: string,
  description: string | undefined,
  tools: BundleToolRef[],
  actor: string,
): Promise<BundleMutationResult> {
  if (!TOOL_NAME_RE.test(name)) {
    return {
      ok: false,
      error: { code: "INVALID_NAME", message: "Bundle name must match /^[a-z0-9][a-z0-9_-]{0,62}$/" },
    };
  }
  const deduped = dedupeToolRefs(tools);

  return withLock(name, async () => {
    const db = getDb();
    const existing = db.query(`SELECT 1 FROM mcp_bundles WHERE name = ?`).get(name);
    if (existing) {
      return { ok: false, error: { code: "ALREADY_EXISTS", message: `Bundle "${name}" already exists` } };
    }
    const unknown = findUnknownTool(db, deduped);
    if (unknown) {
      return {
        ok: false,
        error: { code: "UNKNOWN_TOOL", message: `Unknown tool "${toolKey(unknown.client, unknown.tool)}"` },
      };
    }

    const now = Date.now();
    const txn = db.transaction(() => {
      db.query(
        `INSERT INTO mcp_bundles (name, description, enabled, created_at, updated_at, created_by) VALUES (?, ?, 1, ?, ?, ?)`,
      ).run(name, description ?? null, now, now, actor);
      const insertTool = db.query(
        `INSERT INTO mcp_bundle_tools (bundle_name, client_name, tool_name, created_at) VALUES (?, ?, ?, ?)`,
      );
      for (const t of deduped) insertTool.run(name, t.client, t.tool, now);
    });
    txn();

    liveBundles.set(name, { enabled: true, toolKeys: new Set(deduped.map((t) => toolKey(t.client, t.tool))) });
    notifyToolsChanged();
    return { ok: true };
  });
}

export async function updateBundle(
  name: string,
  updates: { description?: string | null; enabled?: boolean; tools?: BundleToolRef[] },
): Promise<BundleMutationResult> {
  return withLock(name, async () => {
    const db = getDb();
    const existing = db.query(`SELECT 1 FROM mcp_bundles WHERE name = ?`).get(name);
    if (!existing) {
      return { ok: false, error: { code: "NOT_FOUND", message: `Bundle "${name}" not found` } };
    }

    let deduped: BundleToolRef[] | undefined;
    if (updates.tools !== undefined) {
      deduped = dedupeToolRefs(updates.tools);
      const unknown = findUnknownTool(db, deduped);
      if (unknown) {
        return {
          ok: false,
          error: { code: "UNKNOWN_TOOL", message: `Unknown tool "${toolKey(unknown.client, unknown.tool)}"` },
        };
      }
    }

    const now = Date.now();
    const txn = db.transaction(() => {
      if (updates.description !== undefined) {
        db.query(`UPDATE mcp_bundles SET description = ?, updated_at = ? WHERE name = ?`).run(
          updates.description,
          now,
          name,
        );
      }
      if (updates.enabled !== undefined) {
        db.query(`UPDATE mcp_bundles SET enabled = ?, updated_at = ? WHERE name = ?`).run(
          updates.enabled ? 1 : 0,
          now,
          name,
        );
      }
      if (deduped !== undefined) {
        db.query(`DELETE FROM mcp_bundle_tools WHERE bundle_name = ?`).run(name);
        const insertTool = db.query(
          `INSERT INTO mcp_bundle_tools (bundle_name, client_name, tool_name, created_at) VALUES (?, ?, ?, ?)`,
        );
        for (const t of deduped) insertTool.run(name, t.client, t.tool, now);
        if (updates.description === undefined && updates.enabled === undefined) {
          db.query(`UPDATE mcp_bundles SET updated_at = ? WHERE name = ?`).run(now, name);
        }
      }
    });
    txn();

    // Only re-notify connected MCP sessions when visible scope actually
    // changed — description-only edits don't affect tools/list, mirroring
    // why registry.ts's guard setters never call notifyToolsChanged either.
    const scopeChanged = updates.enabled !== undefined || deduped !== undefined;
    const live = liveBundles.get(name);
    if (live) {
      if (updates.enabled !== undefined) live.enabled = updates.enabled;
      if (deduped !== undefined) live.toolKeys = new Set(deduped.map((t) => toolKey(t.client, t.tool)));
    }
    if (scopeChanged) notifyToolsChanged();
    return { ok: true };
  });
}

export async function deleteBundle(name: string): Promise<boolean> {
  return withLock(name, async () => {
    const db = getDb();
    const result = db.query(`DELETE FROM mcp_bundles WHERE name = ?`).run(name);
    if (result.changes === 0) return false;
    liveBundles.delete(name);
    notifyToolsChanged();
    return true;
  });
}
