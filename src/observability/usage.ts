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

/** Start of the current calendar month, UTC (epoch ms). Mirrors consumers.ts's monthStart(). */
function monthStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** One buffered `tool_call_log` row, already normalized to its column order. */
type PendingLogRow = readonly [
  clientName: string,
  toolName: string,
  keyId: number | null,
  statusClass: string,
  isError: 0 | 1,
  durationMs: number,
  createdAt: number,
];

/**
 * How many `tool_call_log` rows one flush may carry.
 *
 * Every autocommit costs a WAL fsync, so the fsync is what a batch amortises:
 * measured per-call cost was 634us at batch 1, 145us at 5, 74us at 10, 31us at
 * 25 and 17us at 50. 20 sits past the knee (~40us, a >15x reduction) while
 * keeping the worst case small in the two dimensions that matter — at most 20
 * analytics rows are in memory rather than in SQLite, and one flush is a single
 * statement with 140 bound parameters, far below SQLite's variable limit.
 * Raising this buys progressively less and widens the loss window; lowering it
 * back toward 1 gives the fsync-per-call cost straight back.
 *
 * Exported so the batching test asserts against this bound rather than a copy of
 * the number that could silently drift from it.
 */
export const USAGE_LOG_BATCH_MAX_ROWS = 20;

let pendingLogRows: PendingLogRow[] = [];
let flushScheduled = false;

/**
 * FRESHNESS GUARANTEE — what a caller may assume about buffered rows.
 *
 * A buffered row is written to SQLite by whichever of these happens first:
 *   1. the buffer reaching USAGE_LOG_BATCH_MAX_ROWS (the amortisation trigger);
 *   2. the end of the current event-loop turn (a microtask scheduled at the
 *      moment the first row is buffered);
 *   3. any read in this module — every getter below flushes first;
 *   4. graceful shutdown (src/index.ts calls this before it starts tearing down).
 *
 * (2) is the delay bound, and it is deliberately a microtask rather than a
 * wall-clock timer: a timer would leave rows unwritten for its whole interval
 * and would need every raw reader of the table to know about it, whereas
 * "at most one event-loop turn" means anything that has awaited ANYTHING since
 * the call was recorded already sees the row. So /admin-api/traffic,
 * /admin-api/usage, sys_diagnose and the admin-UI Activity page cannot show a
 * user a call they just made as missing, and the durability window this opens is
 * strictly smaller than the one `PRAGMA synchronous = NORMAL` already accepts.
 *
 * The consequence to keep in mind: (2) means batching only pays off when several
 * calls finish in the SAME turn, i.e. under the concurrent load where the fsync
 * was measured to be the serialized bottleneck. A single sequential caller still
 * gets one fsync per call — that case is covered by `synchronous = NORMAL`
 * (630us -> 60us), not by this buffer.
 */
export function flushUsageLog(): void {
  if (pendingLogRows.length === 0) return;
  const rows = pendingLogRows;
  pendingLogRows = [];
  try {
    // One multi-row INSERT = one statement = one autocommit = one fsync for the
    // whole batch. Written as a single statement rather than N statements inside
    // an explicit transaction on purpose: a flush can run from a read path, and
    // an explicit BEGIN here would have to reason about every caller that might
    // already hold a transaction open on this shared connection.
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    getDb()
      .query(
        `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at)
         VALUES ${placeholders}`,
      )
      .run(...rows.flat());
  } catch {
    // Best-effort, same contract as recordUsage: analytics must never break a
    // live call, and the rows are already dropped from the buffer so a
    // persistent failure cannot make it grow without bound.
  }
}

/** How often a retention prune is considered: once every N recorded calls. */
const PRUNE_EVERY_N_CALLS = 500;
/**
 * Rows one prune pass may delete. 2000 measured at ~3ms; the unbounded DELETE
 * this replaces measured 15.5ms at 10k expired rows, 271ms at 100k and 892ms at
 * 500k — all of it stalling the event loop, which is what made a retention-window
 * shortening or a long-idle restart show up as a latency spike on live calls.
 */
export const USAGE_PRUNE_MAX_ROWS_PER_PASS = 2000;
/**
 * Consecutive passes one trigger may chain. Bounds the catch-up work: a large
 * backlog drains at up to USAGE_PRUNE_MAX_ROWS_PER_PASS * this per trigger, spread
 * across separate macrotasks so live requests interleave, instead of in one
 * blocking DELETE.
 */
const PRUNE_MAX_PASSES_PER_TRIGGER = 25;

let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Deletes at most USAGE_PRUNE_MAX_ROWS_PER_PASS rows past the retention window and
 * returns how many went. Bounded by construction (the `LIMIT` subquery), so its
 * cost does not scale with how far behind retention has fallen. Exported so the
 * bound itself is directly testable — a timing assertion would be flaky.
 */
export function pruneUsageLogOnce(): number {
  try {
    const res = getDb()
      .query(
        `DELETE FROM tool_call_log WHERE id IN (
           SELECT id FROM tool_call_log WHERE created_at < ? ORDER BY id LIMIT ?
         )`,
      )
      .run(Date.now() - config.usageRetentionMs, USAGE_PRUNE_MAX_ROWS_PER_PASS);
    return res.changes;
  } catch {
    return 0;
  }
}

/**
 * Moves the prune off the request path: the trigger fires inside a live tool
 * call, but the DELETE runs on a later macrotask.
 *
 * What stops it running away: a pass is scheduled only by real traffic (every
 * PRUNE_EVERY_N_CALLS-th recorded call), `pruneTimer` collapses a burst of
 * triggers into one in-flight chain, a chain stops as soon as a pass deletes
 * fewer rows than its own limit (the backlog is drained), and it stops
 * unconditionally after PRUNE_MAX_PASSES_PER_TRIGGER passes. There is no
 * self-perpetuating loop: with no traffic, nothing is ever scheduled.
 *
 * The timer is unref'd so a pending prune can never hold the process open at
 * shutdown — dropping a prune pass loses nothing, the next trigger repeats it.
 */
function schedulePrune(passesLeft: number = PRUNE_MAX_PASSES_PER_TRIGGER): void {
  if (pruneTimer !== null) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    const deleted = pruneUsageLogOnce();
    if (deleted >= USAGE_PRUNE_MAX_ROWS_PER_PASS && passesLeft > 1) {
      schedulePrune(passesLeft - 1);
    }
  }, 0);
  if (pruneTimer.unref) pruneTimer.unref();
}

/**
 * Records one proxied tool call. Best-effort: any failure is swallowed so
 * analytics can never break a live call.
 *
 * The `tool_call_log` row is BUFFERED (see flushUsageLog for the freshness
 * guarantee). The consumer counter deliberately is NOT: it is quota enforcement,
 * not analytics — `checkConsumerQuota` reads that row as its O(1) source of
 * truth, so deferring it would let a consumer overshoot its monthly quota by up
 * to a whole batch.
 */
export function recordUsage(e: UsageEvent): void {
  try {
    const db = getDb();
    pendingLogRows.push([
      e.clientName,
      e.toolName,
      e.keyId,
      e.statusClass,
      e.isError ? 1 : 0,
      Math.max(0, Math.round(e.durationMs)),
      Date.now(),
    ]);
    if (pendingLogRows.length >= USAGE_LOG_BATCH_MAX_ROWS) {
      flushUsageLog();
    } else if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        flushUsageLog();
      });
    }

    // Keep the per-(consumer, month) usage counter in lockstep with the call
    // itself so checkConsumerQuota reads one O(1) row instead of a COUNT(*)
    // scan. The SELECT resolves the call's owning consumer from its key; a null
    // key_id or a key with no consumer matches no row, so this is a no-op for
    // unattributed/consumerless calls (mirrors the rate_counters UPSERT idiom in
    // src/db/rate-counters.ts).
    db.query(
      `INSERT INTO consumer_usage_counters (consumer_id, period_start, count)
       SELECT consumer_id, ?, 1 FROM mcp_api_keys WHERE id = ? AND consumer_id IS NOT NULL
       ON CONFLICT(consumer_id, period_start) DO UPDATE SET count = count + 1`,
    ).run(monthStart(), e.keyId);

    if (++insertCount % PRUNE_EVERY_N_CALLS === 0) {
      schedulePrune();
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

/**
 * Tenancy scope shared by every function below: a number restricts results to
 * calls against a client owned by that team (mirrors `listTraffic`/
 * `listApprovals`'s `teamId` filter); null/undefined (super-admin session or
 * bearer caller) sees every team's usage, matching prior behavior.
 */
function teamScopeCondition(
  conditions: string[],
  params: (string | number)[],
  teamId: number | null | undefined,
): void {
  if (typeof teamId !== "number") return;
  conditions.push("client_name IN (SELECT name FROM clients WHERE team_id = ?)");
  params.push(teamId);
}

export function getUsageSummary(
  opts: { from?: number; to?: number; clientName?: string; teamId?: number | null } = {},
): UsageSummary {
  flushUsageLog(); // readers never see a stale window — see flushUsageLog's guarantee
  const db = getDb();
  const from = windowFrom(opts.from);
  const conditions = ["created_at >= ?"];
  const params: (string | number)[] = [from];
  if (opts.to !== undefined) {
    conditions.push("created_at <= ?");
    params.push(opts.to);
  }
  if (opts.clientName) {
    conditions.push("client_name = ?");
    params.push(opts.clientName);
  }
  teamScopeCondition(conditions, params, opts.teamId);
  const where = `WHERE ${conditions.join(" AND ")}`;
  const row = db
    .query(
      `SELECT COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms, COALESCE(MAX(duration_ms), 0) as max_ms,
              COUNT(DISTINCT client_name || '__' || tool_name) as tools,
              COUNT(DISTINCT key_id) as keys
       FROM tool_call_log ${where}`,
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
export function getUsageTimeseries(
  opts: { from?: number; to?: number; bucketMs?: number; clientName?: string; teamId?: number | null } = {},
): UsageTimeseries {
  flushUsageLog(); // readers never see a stale window — see flushUsageLog's guarantee
  const db = getDb();
  const from = windowFrom(opts.from);
  const to = opts.to ?? Date.now();
  const bucketMs = Math.max(opts.bucketMs ?? defaultBucketMs(to - from), 60_000);
  const conditions = ["created_at >= ?", "created_at <= ?"];
  const params: (string | number)[] = [from, to];
  if (opts.clientName) {
    conditions.push("client_name = ?");
    params.push(opts.clientName);
  }
  teamScopeCondition(conditions, params, opts.teamId);
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .query(
      `SELECT (created_at / ?) as bucket, COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms
       FROM tool_call_log ${where}
       GROUP BY bucket ORDER BY bucket ASC`,
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

export function getTopTools(opts: { from?: number; limit?: number; teamId?: number | null } = {}): TopToolRow[] {
  flushUsageLog(); // readers never see a stale window — see flushUsageLog's guarantee
  const from = windowFrom(opts.from);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const conditions = ["created_at >= ?"];
  const params: (string | number)[] = [from];
  teamScopeCondition(conditions, params, opts.teamId);
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = getDb()
    .query(
      `SELECT client_name, tool_name, COUNT(*) as calls, COALESCE(SUM(is_error), 0) as errors,
              COALESCE(AVG(duration_ms), 0) as avg_ms, COALESCE(MAX(duration_ms), 0) as max_ms
       FROM tool_call_log ${where}
       GROUP BY client_name, tool_name
       ORDER BY calls DESC
       LIMIT ?`,
    )
    .all(...params, limit) as {
    client_name: string;
    tool_name: string;
    calls: number;
    errors: number;
    avg_ms: number;
    max_ms: number;
  }[];
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

export function getUsageByKey(opts: { from?: number; limit?: number; teamId?: number | null } = {}): UsageByKeyRow[] {
  flushUsageLog(); // readers never see a stale window — see flushUsageLog's guarantee
  const from = windowFrom(opts.from);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conditions = ["l.created_at >= ?"];
  const params: (string | number)[] = [from];
  // teamScopeCondition assumes an unqualified `client_name` column, but this
  // query aliases tool_call_log as `l` (joined against mcp_api_keys `k`) — add
  // the equivalent qualified condition directly instead of reusing the helper.
  if (typeof opts.teamId === "number") {
    conditions.push("l.client_name IN (SELECT name FROM clients WHERE team_id = ?)");
    params.push(opts.teamId);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = getDb()
    .query(
      `SELECT l.key_id, k.label, COUNT(*) as calls, COALESCE(SUM(l.is_error), 0) as errors
       FROM tool_call_log l LEFT JOIN mcp_api_keys k ON k.id = l.key_id
       ${where}
       GROUP BY l.key_id
       ORDER BY calls DESC
       LIMIT ?`,
    )
    .all(...params, limit) as { key_id: number | null; label: string | null; calls: number; errors: number }[];
  return rows.map((r) => ({
    keyId: r.key_id,
    label: r.key_id === null ? "(unattributed)" : (r.label ?? `key #${r.key_id}`),
    calls: r.calls,
    errors: r.errors,
  }));
}

/**
 * Test-only: wipe the usage log.
 *
 * Also drops the write buffer and cancels any scheduled prune. Both matter
 * because the whole backend suite shares one process: a buffered row or a
 * pending prune timer left behind by one test would otherwise land inside a
 * later, unrelated one.
 */
export function __clearUsageForTesting(): void {
  pendingLogRows = [];
  if (pruneTimer !== null) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
  try {
    getDb().query(`DELETE FROM tool_call_log`).run();
  } catch {
    // ignore
  }
}
