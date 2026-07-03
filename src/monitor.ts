/**
 * Synthetic monitoring + schema-drift detection (leader-only).
 *
 * A per-tool monitor periodically replays a saved `tool_examples` entry through
 * the full proxy and records ok/fail, and on each run compares the tool's current
 * inputSchema against the baseline captured when the monitor was created — so an
 * upstream that silently changes its contract (schema drift) is flagged even if
 * the call still "works". On failure or drift, an operator webhook is notified.
 *
 * Runs from the existing once-a-minute leader-gated schedule loop, so it needs no
 * separate timer and never double-fires across HA instances.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db/connection.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { registry, TOOL_KEY_SEPARATOR } from "./registry.js";
import { proxyToolCall } from "./proxy.js";

export type MonitorStatus = "ok" | "fail";

export interface MonitorRecord {
  clientName: string;
  toolName: string;
  exampleId: number;
  intervalMinutes: number;
  enabled: boolean;
  driftDetected: boolean;
  lastStatus: MonitorStatus | null;
  lastError: string | null;
  lastCheckedAt: number | null;
}

interface MonitorRow {
  client_name: string;
  tool_name: string;
  example_id: number;
  interval_minutes: number;
  enabled: number;
  baseline_schema_hash: string;
  last_run_minute: number | null;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: number | null;
  drift_detected: number;
}

function rowTo(r: MonitorRow): MonitorRecord {
  return {
    clientName: r.client_name,
    toolName: r.tool_name,
    exampleId: r.example_id,
    intervalMinutes: r.interval_minutes,
    enabled: r.enabled === 1,
    driftDetected: r.drift_detected === 1,
    lastStatus: r.last_status as MonitorStatus | null,
    lastError: r.last_error,
    lastCheckedAt: r.last_checked_at,
  };
}

export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(stableStringify(schema)).digest("hex");
}

export type MonitorError = "TOOL_NOT_LIVE" | "INVALID_INTERVAL";

/**
 * Creates/updates a tool's monitor, capturing the CURRENT inputSchema hash as the
 * drift baseline (so the tool must be live). Returns an error otherwise.
 */
export function setMonitor(
  clientName: string,
  toolName: string,
  input: { exampleId: number; intervalMinutes: number; enabled: boolean },
): { ok: true } | { ok: false; error: MonitorError } {
  if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 1440) {
    return { ok: false, error: "INVALID_INTERVAL" };
  }
  const resolved = registry.resolveTool(`${clientName}${TOOL_KEY_SEPARATOR}${toolName}`);
  if (!resolved) return { ok: false, error: "TOOL_NOT_LIVE" };
  const baseline = schemaHash(resolved.tool.inputSchema);
  getDb()
    .query(
      `INSERT INTO tool_monitor (client_name, tool_name, example_id, interval_minutes, enabled, baseline_schema_hash, drift_detected, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET
         example_id = excluded.example_id,
         interval_minutes = excluded.interval_minutes,
         enabled = excluded.enabled,
         baseline_schema_hash = excluded.baseline_schema_hash,
         drift_detected = 0,
         updated_at = excluded.updated_at`,
    )
    .run(clientName, toolName, input.exampleId, input.intervalMinutes, input.enabled ? 1 : 0, baseline, Date.now());
  return { ok: true };
}

export function deleteMonitor(clientName: string, toolName: string): boolean {
  return (
    getDb().query(`DELETE FROM tool_monitor WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName)
      .changes > 0
  );
}

export function listMonitors(): MonitorRecord[] {
  return (getDb().query(`SELECT * FROM tool_monitor ORDER BY client_name, tool_name`).all() as MonitorRow[]).map(rowTo);
}

/**
 * Runs every enabled monitor whose interval has elapsed: replays its example,
 * checks for schema drift, records the outcome, and notifies on failure/drift.
 * Already leader-gated by the caller. Returns the number of checks run.
 */
export async function runSyntheticChecks(now: Date): Promise<number> {
  const minute = Math.floor(now.getTime() / 60_000);
  const db = getDb();
  const due = db
    .query(
      `SELECT * FROM tool_monitor WHERE enabled = 1 AND (last_run_minute IS NULL OR ? - last_run_minute >= interval_minutes)`,
    )
    .all(minute) as MonitorRow[];

  let ran = 0;
  for (const m of due) {
    const mcpName = `${m.client_name}${TOOL_KEY_SEPARATOR}${m.tool_name}`;
    const args = exampleArgs(m.example_id);

    // Schema drift — compare the live tool's schema to the captured baseline.
    let drift = m.drift_detected === 1;
    const resolved = registry.resolveTool(mcpName);
    if (resolved) drift = schemaHash(resolved.tool.inputSchema) !== m.baseline_schema_hash;

    let status: MonitorStatus;
    let error: string | null;
    if (args === null) {
      status = "fail";
      error = `example #${m.example_id} not found`;
    } else {
      const result = await proxyToolCall(mcpName, args);
      status = result.isError === true ? "fail" : "ok";
      error = result.isError === true ? (result.content[0]?.text ?? "error").slice(0, 500) : null;
    }

    db.query(
      `UPDATE tool_monitor SET last_run_minute = ?, last_status = ?, last_error = ?, last_checked_at = ?, drift_detected = ? WHERE client_name = ? AND tool_name = ?`,
    ).run(minute, status, error, now.getTime(), drift ? 1 : 0, m.client_name, m.tool_name);

    if (status === "fail" || drift) {
      log("warn", "Synthetic monitor flagged a tool", { tool: mcpName, status, drift });
      notifyMonitor(m.client_name, m.tool_name, status, drift);
    }
    ran++;
  }
  return ran;
}

function exampleArgs(exampleId: number): Record<string, unknown> | null {
  const row = getDb().query(`SELECT args_json FROM tool_examples WHERE id = ?`).get(exampleId) as {
    args_json: string;
  } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.args_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function notifyMonitor(clientName: string, toolName: string, status: MonitorStatus, drift: boolean): void {
  const url = config.monitorWebhookUrl;
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "synthetic_monitor", client: clientName, tool: toolName, status, drift }),
    signal: AbortSignal.timeout(config.monitorWebhookTimeoutMs),
  }).catch(() => {});
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
