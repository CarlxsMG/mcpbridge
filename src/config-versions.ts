import { getDb } from "./db/connection.js";
import { exportConfig, importConfig, type ConfigExport, type ImportResult } from "./config-io.js";

/**
 * Config version history on top of config-io's export/import. A snapshot is a
 * full exportConfig() document stored with a label; snapshots can be diffed
 * against each other or against the live config, and a snapshot can be rolled
 * back by re-applying it through importConfig (same best-effort semantics —
 * it reconfigures existing entities and re-creates bundles/alerts, but cannot
 * re-register a client that is no longer present).
 */

export interface SnapshotSummary {
  id: number;
  label: string;
  createdAt: number;
  createdBy: string | null;
}

export interface Snapshot extends SnapshotSummary {
  config: ConfigExport;
}

export interface ConfigDiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

export function createSnapshot(label: string, actor: string | null): SnapshotSummary {
  const db = getDb();
  const now = Date.now();
  const config = exportConfig();
  const row = db
    .query(`INSERT INTO config_snapshots (label, config_json, created_at, created_by) VALUES (?, ?, ?, ?) RETURNING id`)
    .get(label, JSON.stringify(config), now, actor) as { id: number };
  return { id: row.id, label, createdAt: now, createdBy: actor };
}

export function listSnapshots(): SnapshotSummary[] {
  return (getDb()
    .query(`SELECT id, label, created_at, created_by FROM config_snapshots ORDER BY id DESC`)
    .all() as { id: number; label: string; created_at: number; created_by: string | null }[]).map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

export function getSnapshot(id: number): Snapshot | undefined {
  const row = getDb()
    .query(`SELECT id, label, config_json, created_at, created_by FROM config_snapshots WHERE id = ?`)
    .get(id) as { id: number; label: string; config_json: string; created_at: number; created_by: string | null } | null;
  if (!row) return undefined;
  return { id: row.id, label: row.label, createdAt: row.created_at, createdBy: row.created_by, config: JSON.parse(row.config_json) as ConfigExport };
}

export function deleteSnapshot(id: number): boolean {
  return getDb().query(`DELETE FROM config_snapshots WHERE id = ?`).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Canonicalizes a config document so index/key ordering can't produce spurious
 * diffs: object keys are sorted, and arrays whose elements all carry a `name`
 * are sorted by it (clients / bundles / alertRules / tools).
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(canonicalize);
    if (arr.length > 0 && arr.every((x) => x !== null && typeof x === "object" && "name" in (x as Record<string, unknown>))) {
      arr.sort((a, b) => String((a as { name: unknown }).name).localeCompare(String((b as { name: unknown }).name)));
    }
    return arr;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function walk(a: unknown, b: unknown, path: string[], out: ConfigDiffEntry[]): void {
  if (a === b) return;
  const aIsObj = a !== null && typeof a === "object";
  const bIsObj = b !== null && typeof b === "object";
  if (!aIsObj || !bIsObj) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const kind: ConfigDiffEntry["kind"] = a === undefined ? "added" : b === undefined ? "removed" : "changed";
    out.push({ path: path.join(".") || "(root)", kind, before: a, after: b });
    return;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) {
    walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k], out);
  }
}

/** Structured leaf-level diff between two config documents (order-insensitive). */
export function diffConfigs(a: unknown, b: unknown): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  walk(canonicalize(a), canonicalize(b), [], out);
  return out;
}

/**
 * Diffs a snapshot against another snapshot or the live config ("current").
 * Returns undefined when a referenced snapshot doesn't exist.
 */
export function diffSnapshot(id: number, against: number | "current"): { from: SnapshotSummary; to: string; entries: ConfigDiffEntry[] } | undefined {
  const from = getSnapshot(id);
  if (!from) return undefined;
  let toConfig: ConfigExport;
  let toLabel: string;
  if (against === "current") {
    toConfig = exportConfig();
    toLabel = "current";
  } else {
    const other = getSnapshot(against);
    if (!other) return undefined;
    toConfig = other.config;
    toLabel = `#${other.id} ${other.label}`;
  }
  return {
    from: { id: from.id, label: from.label, createdAt: from.createdAt, createdBy: from.createdBy },
    to: toLabel,
    entries: diffConfigs(from.config, toConfig),
  };
}

/** Re-applies a snapshot's config through importConfig. Returns undefined when the snapshot is missing. */
export async function rollbackToSnapshot(id: number, actor: string | null): Promise<ImportResult | undefined> {
  const snap = getSnapshot(id);
  if (!snap) return undefined;
  return importConfig(snap.config, { dryRun: false }, actor);
}
