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
  hasError: boolean;
}

interface SpanRow {
  id: number;
  trace_id: string;
  span_id: string;
  name: string;
  mcp_tool_name: string | null;
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
    startMs: r.start_ms,
    endMs: r.end_ms,
    statusCode: r.status_code as 0 | 1 | 2,
    attributes: JSON.parse(r.attributes_json) as Record<string, AttrValue>,
    createdAt: r.created_at,
  };
}

/** Best-effort insert — never throws into the hot dispatch path. */
export function persistSpan(span: FinishedSpan): void {
  const mcpToolName = typeof span.attributes["mcp.tool"] === "string" ? (span.attributes["mcp.tool"] as string) : null;
  try {
    getDb()
      .query(
        `INSERT INTO tool_spans (trace_id, span_id, name, mcp_tool_name, start_ms, end_ms, status_code, attributes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(span.traceId, span.spanId, span.name, mcpToolName, span.startMs, span.endMs, span.statusCode, JSON.stringify(span.attributes), Date.now());
  } catch (err) {
    log("warn", "Failed to persist span for trace viewer", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (Math.random() < 0.02) pruneSpans();
}

/** Recent traces (one row per trace_id), most recent first. */
export function listTraces(filter: { mcpToolName?: string; limit?: number } = {}): TraceSummary[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.mcpToolName) {
    where.push("mcp_tool_name = ?");
    params.push(filter.mcpToolName);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const sql = `
    SELECT trace_id, COUNT(*) as span_count, MIN(start_ms) as start_ms, MAX(end_ms) as end_ms,
           MAX(status_code) as status_code, MAX(mcp_tool_name) as mcp_tool_name
    FROM tool_spans
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY trace_id
    ORDER BY start_ms DESC
    LIMIT ${limit}
  `;
  const rows = getDb().query(sql).all(...params) as {
    trace_id: string;
    span_count: number;
    start_ms: number;
    end_ms: number;
    status_code: number;
    mcp_tool_name: string | null;
  }[];
  return rows.map((r) => ({
    traceId: r.trace_id,
    spanCount: r.span_count,
    startMs: r.start_ms,
    endMs: r.end_ms,
    mcpToolName: r.mcp_tool_name,
    hasError: r.status_code === 2,
  }));
}

/** Every span belonging to one trace, in chronological order (the waterfall view's data). */
export function getTrace(traceId: string): StoredSpan[] {
  return (getDb().query(`SELECT * FROM tool_spans WHERE trace_id = ? ORDER BY start_ms ASC`).all(traceId) as SpanRow[]).map(rowTo);
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
