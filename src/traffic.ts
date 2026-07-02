/**
 * Per-call traffic capture for the admin traffic explorer + replay.
 *
 * Distinct from `tool_call_log` (aggregate metadata for usage/metrics): this
 * records the actual request args and a preview of the (already redacted/
 * guardrail-processed) result, so an operator can inspect and re-run a specific
 * call while debugging. Opt-in globally (`TRAFFIC_CAPTURE`, off by default —
 * payloads have privacy/volume cost) and time-bounded by `TRAFFIC_RETENTION_MS`.
 *
 * Args are stored in full (they're the caller's own inputs, already size-bounded
 * by the inbound body limits) so a replay is faithful; only the result preview
 * is truncated.
 */
import { getDb } from "./db/connection.js";
import { config } from "./config.js";

export interface TrafficRecord {
  id: number;
  mcpToolName: string;
  clientName: string | null;
  toolName: string | null;
  keyId: number | null;
  argsJson: string;
  preview: string;
  isError: boolean;
  durationMs: number;
  createdAt: number;
}

interface TrafficRow {
  id: number;
  mcp_tool_name: string;
  client_name: string | null;
  tool_name: string | null;
  key_id: number | null;
  args_json: string;
  preview: string;
  is_error: number;
  duration_ms: number;
  created_at: number;
}

function rowTo(r: TrafficRow): TrafficRecord {
  return {
    id: r.id,
    mcpToolName: r.mcp_tool_name,
    clientName: r.client_name,
    toolName: r.tool_name,
    keyId: r.key_id,
    argsJson: r.args_json,
    preview: r.preview,
    isError: r.is_error === 1,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
}

export function recordTraffic(input: {
  mcpToolName: string;
  clientName: string | null;
  toolName: string | null;
  keyId: number | null;
  args: Record<string, unknown>;
  result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  durationMs: number;
}): void {
  const argsJson = safeJson(input.args);
  const preview = truncate((input.result.content ?? []).map((c) => c.text ?? "").join("\n"), config.trafficMaxBodyBytes);
  getDb()
    .query(
      `INSERT INTO tool_traffic (mcp_tool_name, client_name, tool_name, key_id, args_json, preview, is_error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.mcpToolName, input.clientName, input.toolName, input.keyId, argsJson, preview, input.result.isError ? 1 : 0, input.durationMs, Date.now());
  if (Math.random() < 0.02) pruneTraffic();
}

export function listTraffic(filter: { clientName?: string; toolName?: string; errorsOnly?: boolean; limit?: number } = {}): TrafficRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.clientName) {
    where.push("client_name = ?");
    params.push(filter.clientName);
  }
  if (filter.toolName) {
    where.push("tool_name = ?");
    params.push(filter.toolName);
  }
  if (filter.errorsOnly) where.push("is_error = 1");
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  const sql = `SELECT * FROM tool_traffic ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
  return (getDb().query(sql).all(...params) as TrafficRow[]).map(rowTo);
}

export function getTraffic(id: number): TrafficRecord | null {
  const row = getDb().query(`SELECT * FROM tool_traffic WHERE id = ?`).get(id) as TrafficRow | null;
  return row ? rowTo(row) : null;
}

/** Deletes traffic rows older than the retention window. Returns rows removed. */
export function pruneTraffic(now: number = Date.now()): number {
  const cutoff = now - config.trafficRetentionMs;
  return getDb().query(`DELETE FROM tool_traffic WHERE created_at < ?`).run(cutoff).changes;
}

export function __clearTrafficForTesting(): void {
  getDb().query(`DELETE FROM tool_traffic`).run();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return '"<unserializable>"';
  }
}
