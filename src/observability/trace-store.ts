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
import { clampLimit, keysetPaginate } from "../lib/pagination-cursor.js";
import type { FinishedSpan, AttrValue } from "./tracing.js";
import { errorMessage } from "../lib/error-message.js";

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
    log("warn", "Failed to persist span for trace viewer", { error: errorMessage(err) });
    return;
  }
  if (Math.random() < 0.02) pruneSpans();
}

/**
 * Tenancy scope for a team-bound caller, mirroring audit.ts's
 * teamScopeCondition: `mcp_tool_name` is always a `clientName__toolName`
 * composite key (every persisted span comes from proxyToolCall's single
 * startSpan call site), so — unlike audit's free-form `target` — this only
 * needs the composite-key branch, matched against the caller's team's own
 * clients. A span whose `mcp_tool_name` is NULL (shouldn't happen in
 * practice, but the schema allows it) or doesn't match any of the caller's
 * team's clients is hidden/excluded — fail-closed, same as the rest of the
 * tenancy model.
 */
function traceTeamScopeCondition(
  conditions: string[],
  params: (string | number)[],
  teamId: number | null | undefined,
): void {
  if (typeof teamId !== "number") return;
  conditions.push(
    `EXISTS (SELECT 1 FROM clients c WHERE c.team_id = ? AND substr(mcp_tool_name, 1, length(c.name) + 2) = c.name || '__')`,
  );
  params.push(teamId);
}

/**
 * Recent traces (one row per trace_id), most recent first.
 *
 * Keyset-paginated on `MAX(id)` per trace group rather than `start_ms`: `id`
 * is AUTOINCREMENT and thus guaranteed unique/monotonic, whereas two traces'
 * spans can share a millisecond-resolution `start_ms` and silently collide as
 * a cursor. `cursor` is the `lastId` of the last trace returned to the caller.
 * Fetches one extra group to determine `nextCursor` without a second query.
 *
 * `teamId`: pass the caller's team id to scope the listing to spans for that
 * team's own clients (see traceTeamScopeCondition); omit for an
 * unrestricted, system-wide listing (super-admin/bearer callers).
 */
export function listTraces(
  filter: { mcpToolName?: string; sessionId?: string; cursor?: string; limit?: number; teamId?: number } = {},
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
  traceTeamScopeCondition(where, params, filter.teamId);
  const having = filter.cursor ? "HAVING MAX(id) < ?" : "";
  if (filter.cursor) params.push(Number(filter.cursor));
  const limit = clampLimit(filter.limit, 50, 500);
  const sql = `
    SELECT trace_id, COUNT(*) as span_count, MIN(start_ms) as start_ms, MAX(end_ms) as end_ms,
           MAX(status_code) as status_code, MAX(mcp_tool_name) as mcp_tool_name, MAX(session_id) as session_id,
           MAX(id) as last_id
    FROM tool_spans
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY trace_id
    ${having}
    ORDER BY last_id DESC
  `;
  return keysetPaginate<
    {
      trace_id: string;
      span_count: number;
      start_ms: number;
      end_ms: number;
      status_code: number;
      mcp_tool_name: string | null;
      session_id: string | null;
      last_id: number;
    },
    TraceSummary
  >(
    getDb(),
    sql,
    params,
    limit,
    (r) => ({
      traceId: r.trace_id,
      spanCount: r.span_count,
      startMs: r.start_ms,
      endMs: r.end_ms,
      mcpToolName: r.mcp_tool_name,
      sessionId: r.session_id,
      hasError: r.status_code === 2,
    }),
    (r) => r.last_id,
  );
}

export interface TopSessionRow {
  sessionId: string;
  calls: number;
  hasError: boolean;
}

/** Top MCP session ids by span (tool call) volume — powers the "which session
 *  is causing this spike" trace-viewer summary. Sessions are ephemeral
 *  (transports.ts evicts them on TTL/close), so this is always scoped to
 *  whatever spans are still within the retention window.
 *
 *  `teamId`: pass the caller's team id to count only spans for that team's
 *  own clients (see traceTeamScopeCondition) — a session that also called
 *  another tenant's tools still appears, but its `calls`/`hasError` only
 *  reflect the caller's own team's spans. Omit for an unrestricted count. */
export function getTopSessions(limit = 10, teamId?: number): TopSessionRow[] {
  const where = ["session_id IS NOT NULL"];
  const params: number[] = [];
  traceTeamScopeCondition(where, params, teamId);
  const rows = getDb()
    .query(
      `SELECT session_id, COUNT(*) as calls, MAX(status_code) as max_status
       FROM tool_spans
       WHERE ${where.join(" AND ")}
       GROUP BY session_id
       ORDER BY calls DESC
       LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(limit, 1), 100)) as {
    session_id: string;
    calls: number;
    max_status: number;
  }[];
  return rows.map((r) => ({ sessionId: r.session_id, calls: r.calls, hasError: r.max_status === 2 }));
}

/**
 * Every span belonging to one trace, in chronological order (the waterfall
 * view's data). `teamId`: pass the caller's team id to only return spans
 * belonging to that team's own clients — a trace with no spans owned by the
 * caller's team comes back empty, which the route already treats identically
 * to "trace not found" (fail-closed, same as ensureClientAccess elsewhere).
 * Omit for an unrestricted lookup.
 */
export function getTrace(traceId: string, teamId?: number): StoredSpan[] {
  const where = ["trace_id = ?"];
  const params: (string | number)[] = [traceId];
  traceTeamScopeCondition(where, params, teamId);
  return (
    getDb()
      .query(`SELECT * FROM tool_spans WHERE ${where.join(" AND ")} ORDER BY start_ms ASC`)
      .all(...params) as SpanRow[]
  ).map(rowTo);
}

/** Deletes spans older than the retention window. Returns rows removed. */
export function pruneSpans(now: number = Date.now()): number {
  const cutoff = now - config.traceRetentionMs;
  return getDb().query(`DELETE FROM tool_spans WHERE created_at < ?`).run(cutoff).changes;
}

/**
 * Deletes persisted spans (manual admin purge). `teamId`: pass the caller's
 * team id to delete only that team's own spans (a team-scoped admin must not
 * be able to wipe another tenant's trace history); omit for a full,
 * system-wide purge (super-admin/bearer callers).
 */
export function purgeAllSpans(teamId?: number): number {
  if (typeof teamId === "number") {
    return getDb()
      .query(
        `DELETE FROM tool_spans WHERE EXISTS (SELECT 1 FROM clients c WHERE c.team_id = ? AND substr(mcp_tool_name, 1, length(c.name) + 2) = c.name || '__')`,
      )
      .run(teamId).changes;
  }
  return getDb().query(`DELETE FROM tool_spans`).run().changes;
}

export function __clearSpansForTesting(): void {
  getDb().query(`DELETE FROM tool_spans`).run();
}
