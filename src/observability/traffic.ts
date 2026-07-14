/**
 * Per-call traffic capture for the admin traffic explorer + replay.
 *
 * Distinct from `tool_call_log` (aggregate metadata for usage/metrics): this
 * records the actual request args and a preview of the (already redacted/
 * guardrail-processed) result, so an operator can inspect and re-run a specific
 * call while debugging. Opt-in globally (`TRAFFIC_CAPTURE`, off by default —
 * payloads have privacy/volume cost) and time-bounded by `TRAFFIC_RETENTION_MS`.
 *
 * Args are stored in full for faithful replay — EXCEPT any dot-paths the
 * operator configured as redactions for the tool, which are stripped from the
 * stored args too (not just the result preview), so a secret that arrives as a
 * call argument isn't persisted in plaintext. Tools without redaction configured
 * keep full args. The result preview is truncated.
 */
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { clampLimit, keysetPaginate } from "../lib/pagination-cursor.js";
import { errorMessage } from "../lib/error-message.js";
import { getRedactionPaths, applyRedaction } from "../content-filtering/redaction.js";

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
  let argsJson = safeJson(input.args);
  const preview = truncate(
    (input.result.content ?? []).map((c) => c.text ?? "").join("\n"),
    config.trafficMaxBodyBytes,
  );
  try {
    // Strip the tool's configured redaction paths from the stored args too — an
    // operator who marked a field sensitive shouldn't have it persisted in
    // plaintext when it arrives as a call argument. Opt-in per tool; unmatched
    // paths (and tools with no redaction) leave the args intact for replay.
    // Inside the try so a redaction-read failure fails closed (no write) rather
    // than persisting unredacted args.
    if (input.clientName && input.toolName) {
      const paths = getRedactionPaths(input.clientName, input.toolName);
      if (paths.length > 0) argsJson = applyRedaction(paths, argsJson) ?? argsJson;
    }
    getDb()
      .query(
        `INSERT INTO tool_traffic (mcp_tool_name, client_name, tool_name, key_id, args_json, preview, is_error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.mcpToolName,
        input.clientName,
        input.toolName,
        input.keyId,
        argsJson,
        preview,
        input.result.isError ? 1 : 0,
        input.durationMs,
        Date.now(),
      );
  } catch (err) {
    log("warn", "Failed to record traffic capture", { error: errorMessage(err) });
    return;
  }
  if (Math.random() < 0.02) pruneTraffic();
}

/**
 * Keyset-paginated (by `id`, matching the audit-log idiom): rows are ordered
 * `id DESC`, so `cursor` is the `id` of the last row returned to the caller —
 * translated to `WHERE id < ?`. Fetches one extra row to determine `nextCursor`
 * without a second COUNT query.
 */
export function listTraffic(
  filter: {
    clientName?: string;
    toolName?: string;
    errorsOnly?: boolean;
    cursor?: string;
    limit?: number;
    /**
     * Tenancy scope. A number restricts results to records whose client is owned
     * by that team; null/undefined (super-admin / bearer) sees every record.
     * Records with no client_name are only visible to super-admins.
     */
    teamId?: number | null;
  } = {},
): { items: TrafficRecord[]; nextCursor?: string } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.cursor) {
    where.push("id < ?");
    params.push(Number(filter.cursor));
  }
  if (filter.clientName) {
    where.push("client_name = ?");
    params.push(filter.clientName);
  }
  if (filter.toolName) {
    where.push("tool_name = ?");
    params.push(filter.toolName);
  }
  if (filter.errorsOnly) where.push("is_error = 1");
  if (typeof filter.teamId === "number") {
    // Team-scoped caller: only records for a client their team owns. The subquery
    // is a static fragment; team_id is bound as a parameter.
    where.push("client_name IN (SELECT name FROM clients WHERE team_id = ?)");
    params.push(filter.teamId);
  }
  const limit = clampLimit(filter.limit, 100, 1000);
  const sql = `SELECT * FROM tool_traffic ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return keysetPaginate<TrafficRow, TrafficRecord>(getDb(), sql, params, limit, rowTo, (r) => r.id);
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
