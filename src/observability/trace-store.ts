/**
 * SQLite-persisted spans for the admin-UI trace viewer — independent of (and
 * off by default like) OTLP export; see tracing.ts's endSpan for the
 * integration point. Distinct from tool_traffic (args/result preview) and
 * tool_call_log (aggregate usage): this is per-span timing/status for a
 * waterfall view, keyed by trace id (currently 1 span per tool call in
 * practice, but the schema supports multiple spans per trace).
 *
 * Opt-in (`TRACE_STORAGE`) because volume is one row per tool call; pruned by
 * age (`TRACE_RETENTION_MS`, default 24h) the same probabilistic way
 * traffic.ts prunes tool_traffic.
 */
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { FinishedSpan, AttrValue } from "./tracing.js";

export interface StoredSpan {
  id: number;
  traceId: string;
  spanId: string;
  name: string;
  mcpToolName: string | null;
  sessionId: string | null;
  startMs: number;
  endMs: number;
  statusCode: 0 | 1 | 2;
  attributes: Record<string, AttrValue>;
  createdAt: number;
}

export interface TraceSummary {
  traceId: string;
  spanCount: number;
  startMs: number;
  endMs: number;
  mcpToolName: string | null;
  sessionId: string | null;
  hasError: boolean;
}

interface SpanRow {
  id: number;
  trace_id: string;
  span_id: string;
  name: string;
  mcp_tool_name: string | null;
  session_id: string | null;
  start_ms: number;
  end_ms: number;
  status_code: number;
  attributes_json: string;
  created_at: number;
}

function rowTo(r: SpanRow): StoredSpan {
  return {
    id: r.id,
    traceId: r.trace_id,
    spanId: r.span_id,
    name: r.name,
    mcpToolName: r.mcp_tool_name,
    sessionId: r.session_id,
    startMs: r.start_ms,
    endMs: r.end_ms,
    statusCode: r.status_code as 0 | 1 | 2,
    attributes: JSON.parse(r.attributes_json) as Record<string, AttrValue>,
    createdAt: r.created_at,
  };
}

/**
 * Best-effort insert — never throws into the hot dispatch path.
 *
 * `mcp.tool` and `mcp.session_id` are pulled out of the merged attributes bag
 * (set by proxyToolCall's startSpan/endSpan calls) into their own dedicated
 * columns, the same way mcp_tool_name has always worked — attributes_json
 * still carries the full set for the waterfall detail view, but the columns
 * are what make list-filtering (by tool, and now by session) index-backed
 * instead of a full-table JSON scan.
 */
export function persistSpan(span: FinishedSpan): void {
  const mcpToolName = typeof span.attributes["mcp.tool"] === "string" ? (span.attributes["mcp.tool"] as string) : null;
  const sessionId =
    typeof span.attributes["mcp.session_id"] === "string" ? (span.attributes["mcp.session_id"] as string) : null;
  try {
    getDb()
      .query(
        `INSERT INTO tool_spans (trace_id, span_id, name, mcp_tool_name, session_id, start_ms, end_ms, status_code, attributes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        span.traceId,
        span.spanId,
        span.name,
        mcpToolName,
        sessionId,
        span.startMs,
        span.endMs,
        span.statusCode,
        JSON.stringify(span.attributes),
        Date.now(),
      );
  } catch (err) {
    log("warn", "Failed to persist span for trace viewer", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (Math.random() < 0.02) pruneSpans();
}

/**
 * Recent traces (one row per trace_id), most recent first.
 *
 * Keyset-paginated on `MAX(id)` per trace group rather than `start_ms`: `id`
 * is AUTOINCREMENT and thus guaranteed unique/monotonic, whereas two traces'
 * spans can share a millisecond-resolution `start_ms` and silently collide as
 * a cursor. `cursor` is the `lastId` of the last trace returned to the caller.
 * Fetches one extra group to determine `nextCursor` without a second query.
 */
export function listTraces(
  filter: { mcpToolName?: string; sessionId?: string; cursor?: string; limit?: number } = {},
): {
  items: TraceSummary[];
  nextCursor?: string;
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.mcpToolName) {
    where.push("mcp_tool_name = ?");
    params.push(filter.mcpToolName);
  }
  if (filter.sessionId) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  const having = filter.cursor ? "HAVING MAX(id) < ?" : "";
  if (filter.cursor) params.push(Number(filter.cursor));
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const sql = `
    SELECT trace_id, COUNT(*) as span_count, MIN(start_ms) as start_ms, MAX(end_ms) as end_ms,
           MAX(status_code) as status_code, MAX(mcp_tool_name) as mcp_tool_name, MAX(session_id) as session_id,
           MAX(id) as last_id
    FROM tool_spans
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY trace_id
    ${having}
    ORDER BY last_id DESC
    LIMIT ?
  `;
  const rows = getDb()
    .query(sql)
    .all(...params, limit + 1) as {
    trace_id: string;
    span_count: number;
    start_ms: number;
    end_ms: number;
    status_code: number;
    mcp_tool_name: string | null;
    session_id: string | null;
    last_id: number;
  }[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: TraceSummary[] = page.map((r) => ({
    traceId: r.trace_id,
    spanCount: r.span_count,
    startMs: r.start_ms,
    endMs: r.end_ms,
    mcpToolName: r.mcp_tool_name,
    sessionId: r.session_id,
    hasError: r.status_code === 2,
  }));
  return { items, nextCursor: hasMore ? String(page[page.length - 1].last_id) : undefined };
}

export interface TopSessionRow {
  sessionId: string;
  calls: number;
  hasError: boolean;
}

/** Top MCP session ids by span (tool call) volume — powers the "which session
 *  is causing this spike" trace-viewer summary. Sessions are ephemeral
 *  (transports.ts evicts them on TTL/close), so this is always scoped to
 *  whatever spans are still within the retention window. */
export function getTopSessions(limit = 10): TopSessionRow[] {
  const rows = getDb()
    .query(
      `SELECT session_id, COUNT(*) as calls, MAX(status_code) as max_status
       FROM tool_spans
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY calls DESC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 100)) as { session_id: string; calls: number; max_status: number }[];
  return rows.map((r) => ({ sessionId: r.session_id, calls: r.calls, hasError: r.max_status === 2 }));
}

/** Every span belonging to one trace, in chronological order (the waterfall view's data). */
export function getTrace(traceId: string): StoredSpan[] {
  return (
    getDb().query(`SELECT * FROM tool_spans WHERE trace_id = ? ORDER BY start_ms ASC`).all(traceId) as SpanRow[]
  ).map(rowTo);
}

/** Deletes spans older than the retention window. Returns rows removed. */
export function pruneSpans(now: number = Date.now()): number {
  const cutoff = now - config.traceRetentionMs;
  return getDb().query(`DELETE FROM tool_spans WHERE created_at < ?`).run(cutoff).changes;
}

/** Deletes every persisted span (manual admin purge). */
export function purgeAllSpans(): number {
  return getDb().query(`DELETE FROM tool_spans`).run().changes;
}

export function __clearSpansForTesting(): void {
  getDb().query(`DELETE FROM tool_spans`).run();
}
