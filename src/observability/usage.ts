import { getDb } from "../db/connection.js";
import { config } from "../config.js";

export interface UsageEvent {
  clientName: string;
  toolName: string;
  /** Managed MCP key id, or null for env-key / admin-test / unauthenticated calls. */
  keyId: number | null;
  statusClass: string;
  isError: boolean;
  durationMs: number;
}

let insertCount = 0;

/**
 * Records one proxied tool call. Best-effort: any failure is swallowed so
 * analytics can never break a live call. Every 500th insert opportunistically
 * prunes rows past the retention window (cheap thanks to the created_at index).
 */
export function recordUsage(e: UsageEvent): void {
  try {
    const db = getDb();
    db.query(
      `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(e.clientName, e.toolName, e.keyId, e.statusClass, e.isError ? 1 : 0, Math.max(0, Math.round(e.durationMs)), Date.now());

    if (++insertCount % 500 === 0) {
      db.query(`DELETE FROM tool_call_log WHERE created_at < ?`).run(Date.now() - config.usageRetentionMs);
    }
  } catch {
    // best-effort — never let usage logging break a proxied call
  }
}

function windowFrom(from?: number): number {
  return from ?? Date.now() - 7 * 24 * 60 * 60_000;
}

export interface UsageSummary {
  from: number;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  maxMs: number;
  tools: number;
  keys: number;
}

export function getUsageSummary(opts: { from?: number; to?: number; clientName?: string } = {}): UsageSummary {
  const db = getDb();
  const from = windowFrom(opts.from);
  const conditions = ["created_at >= ?"];
  const params: (string | number)[] = [from];
  if (opts.to !== undefined) { conditions.push("created_at <= ?"); params.push(opts.to); }
  if (opts.clientName) { conditions.push("client_name = ?"); params.push(opts.clientName); }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const row = db
    .query(
      `SELECT COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms, COALESCE(MAX(duration_ms), 0) as max_ms,
              COUNT(DISTINCT client_name || '__' || tool_name) as tools,
              COUNT(DISTINCT key_id) as keys
       FROM tool_call_log ${where}`
    )
    .get(...params) as { calls: number; errors: number; avg_ms: number; max_ms: number; tools: number; keys: number };
  return {
    from,
    calls: row.calls,
    errors: row.errors,
    errorRate: row.calls > 0 ? row.errors / row.calls : 0,
    avgMs: Math.round(row.avg_ms),
    maxMs: row.max_ms,
    tools: row.tools,
    keys: row.keys,
  };
}

function defaultBucketMs(windowMs: number): number {
  return windowMs <= 26 * 60 * 60_000 ? 60 * 60_000 : 24 * 60 * 60_000;
}

export interface UsageTimeseriesPoint {
  t: number;
  calls: number;
  errors: number;
  avgMs: number;
}

export interface UsageTimeseries {
  bucketMs: number;
  points: UsageTimeseriesPoint[];
}

const MAX_TIMESERIES_POINTS = 1000;

/** Bucketed calls/errors/avgMs over the window, zero-filled so charts never see gaps. */
export function getUsageTimeseries(opts: { from?: number; to?: number; bucketMs?: number; clientName?: string } = {}): UsageTimeseries {
  const db = getDb();
  const from = windowFrom(opts.from);
  const to = opts.to ?? Date.now();
  const bucketMs = Math.max(opts.bucketMs ?? defaultBucketMs(to - from), 60_000);
  const conditions = ["created_at >= ?", "created_at <= ?"];
  const params: (string | number)[] = [from, to];
  if (opts.clientName) { conditions.push("client_name = ?"); params.push(opts.clientName); }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .query(
      `SELECT (created_at / ?) as bucket, COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms
       FROM tool_call_log ${where}
       GROUP BY bucket ORDER BY bucket ASC`
    )
    .all(bucketMs, ...params) as { bucket: number; calls: number; errors: number; avg_ms: number }[];

  const byBucket = new Map(rows.map((r) => [r.bucket * bucketMs, r]));
  const firstBucket = Math.floor(from / bucketMs) * bucketMs;
  const lastBucket = Math.floor(to / bucketMs) * bucketMs;
  const points: UsageTimeseriesPoint[] = [];
  for (let t = firstBucket; t <= lastBucket && points.length < MAX_TIMESERIES_POINTS; t += bucketMs) {
    const r = byBucket.get(t);
    points.push({ t, calls: r?.calls ?? 0, errors: r?.errors ?? 0, avgMs: r ? Math.round(r.avg_ms) : 0 });
  }
  return { bucketMs, points };
}

export interface TopToolRow {
  client: string;
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  maxMs: number;
}

export function getTopTools(opts: { from?: number; limit?: number } = {}): TopToolRow[] {
  const from = windowFrom(opts.from);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = getDb()
    .query(
      `SELECT client_name, tool_name, COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms, COALESCE(MAX(duration_ms), 0) as max_ms
       FROM tool_call_log WHERE created_at >= ?
       GROUP BY client_name, tool_name
       ORDER BY calls DESC
       LIMIT ?`
    )
    .all(from, limit) as { client_name: string; tool_name: string; calls: number; errors: number; avg_ms: number; max_ms: number }[];
  return rows.map((r) => ({
    client: r.client_name,
    tool: r.tool_name,
    calls: r.calls,
    errors: r.errors,
    errorRate: r.calls > 0 ? r.errors / r.calls : 0,
    avgMs: Math.round(r.avg_ms),
    maxMs: r.max_ms,
  }));
}

export interface UsageByKeyRow {
  keyId: number | null;
  label: string;
  calls: number;
  errors: number;
}

export function getUsageByKey(opts: { from?: number; limit?: number } = {}): UsageByKeyRow[] {
  const from = windowFrom(opts.from);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = getDb()
    .query(
      `SELECT l.key_id, k.label, COUNT(*) as calls, COALESCE(SUM(l.is_error), 0) as errors
       FROM tool_call_log l LEFT JOIN mcp_api_keys k ON k.id = l.key_id
       WHERE l.created_at >= ?
       GROUP BY l.key_id
       ORDER BY calls DESC
       LIMIT ?`
    )
    .all(from, limit) as { key_id: number | null; label: string | null; calls: number; errors: number }[];
  return rows.map((r) => ({
    keyId: r.key_id,
    label: r.key_id === null ? "(unattributed)" : r.label ?? `key #${r.key_id}`,
    calls: r.calls,
    errors: r.errors,
  }));
}

/** Test-only: wipe the usage log. */
export function __clearUsageForTesting(): void {
  try {
    getDb().query(`DELETE FROM tool_call_log`).run();
  } catch {
    // ignore
  }
}
