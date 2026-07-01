import { getDb } from "./db/connection.js";
import { registry } from "./registry.js";
import { recordAudit } from "./admin/audit.js";
import { isLeader } from "./db/leader-lease.js";
import { log } from "./logger.js";

/**
 * Maintenance schedules: cron-driven enable/disable of a client or a single
 * tool. The evaluator runs once a minute, LEADER-ONLY (same gate as the alert
 * loop) so a multi-instance deployment applies each fire exactly once, and it
 * de-dupes within a minute via last_run_minute so a schedule can't double-fire.
 * Actions go through the same registry setters an admin would call, so all the
 * usual persistence/notify behaviour applies.
 */

export type ScheduleTarget = "client" | "tool";
export type ScheduleAction = "enable" | "disable";

export interface Schedule {
  id: number;
  targetType: ScheduleTarget;
  clientName: string;
  toolName: string | null;
  action: ScheduleAction;
  cron: string;
  enabled: boolean;
  lastRunMinute: number | null;
  createdAt: number;
  createdBy: string | null;
}

interface ScheduleRow {
  id: number;
  target_type: string;
  client_name: string;
  tool_name: string | null;
  action: string;
  cron: string;
  enabled: number;
  last_run_minute: number | null;
  created_at: number;
  created_by: string | null;
}

function rowTo(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    targetType: r.target_type as ScheduleTarget,
    clientName: r.client_name,
    toolName: r.tool_name,
    action: r.action as ScheduleAction,
    cron: r.cron,
    enabled: r.enabled === 1,
    lastRunMinute: r.last_run_minute,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

// ---------------------------------------------------------------------------
// Minimal 5-field cron matcher (minute hour day-of-month month day-of-week).
// Supports *, a, a-b, a-b/step, */step, and comma-lists thereof. All five
// fields are AND-matched (no Vixie DOM/DOW OR special case) — simple and
// predictable; real maintenance windows leave one of DOM/DOW as *.
// ---------------------------------------------------------------------------

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        lo = hi = Number(bounds[0]);
      } else if (bounds.length === 2) {
        lo = Number(bounds[0]);
        hi = Number(bounds[1]);
      } else {
        return null;
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

/** True when `date` (evaluated in UTC) satisfies the cron expression. */
export function cronMatches(expr: string, date: Date): boolean {
  const p = parseCron(expr);
  if (!p) return false;
  return (
    p.minute.has(date.getUTCMinutes()) &&
    p.hour.has(date.getUTCHours()) &&
    p.dom.has(date.getUTCDate()) &&
    p.month.has(date.getUTCMonth() + 1) &&
    p.dow.has(date.getUTCDay())
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listSchedules(): Schedule[] {
  return (getDb().query(`SELECT * FROM schedules ORDER BY id`).all() as ScheduleRow[]).map(rowTo);
}

export type ScheduleCreateError = "INVALID_CRON" | "INVALID_TARGET";

export function createSchedule(input: {
  targetType: ScheduleTarget;
  clientName: string;
  toolName?: string | null;
  action: ScheduleAction;
  cron: string;
  actor: string | null;
}): Schedule | ScheduleCreateError {
  if (!parseCron(input.cron)) return "INVALID_CRON";
  if (input.targetType !== "client" && input.targetType !== "tool") return "INVALID_TARGET";
  if (input.action !== "enable" && input.action !== "disable") return "INVALID_TARGET";
  if (input.targetType === "tool" && !input.toolName) return "INVALID_TARGET";
  const toolName = input.targetType === "tool" ? input.toolName! : null;

  const db = getDb();
  // The client FK would otherwise throw; return a clean error instead.
  if (!db.query(`SELECT 1 FROM clients WHERE name = ?`).get(input.clientName)) return "INVALID_TARGET";
  if (toolName && !db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(input.clientName, toolName)) return "INVALID_TARGET";

  const now = Date.now();
  const row = db
    .query(
      `INSERT INTO schedules (target_type, client_name, tool_name, action, cron, enabled, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`
    )
    .get(input.targetType, input.clientName, toolName, input.action, input.cron, now, input.actor) as ScheduleRow;
  return rowTo(row);
}

export function setScheduleEnabled(id: number, enabled: boolean): boolean {
  return getDb().query(`UPDATE schedules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id).changes > 0;
}

export function deleteSchedule(id: number): boolean {
  return getDb().query(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

async function applySchedule(s: Schedule): Promise<void> {
  const enable = s.action === "enable";
  if (s.targetType === "client") {
    await registry.setClientEnabled(s.clientName, enable);
  } else if (s.toolName) {
    await registry.setToolEnabled(s.clientName, s.toolName, enable);
  }
  const target = s.targetType === "client" ? s.clientName : `${s.clientName}__${s.toolName}`;
  recordAudit("scheduler", `schedule.${s.action}`, target, { scheduleId: s.id });
}

/**
 * Applies every enabled schedule whose cron matches `now`, skipping any that
 * already ran this same minute. Exported (rather than only run by the timer) so
 * it is directly testable without wall-clock waiting. Returns the fire count.
 */
export async function runDueSchedules(now: Date): Promise<number> {
  const currentMinute = Math.floor(now.getTime() / 60_000);
  const db = getDb();
  let fired = 0;
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    if (s.lastRunMinute === currentMinute) continue;
    if (!cronMatches(s.cron, now)) continue;
    try {
      await applySchedule(s);
      db.query(`UPDATE schedules SET last_run_minute = ? WHERE id = ?`).run(currentMinute, s.id);
      fired++;
    } catch (err) {
      log("error", "Schedule application failed", { scheduleId: s.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return fired;
}

/** Starts the once-a-minute, leader-only evaluator. Returns a stop function. */
export function startScheduleLoop(): () => void {
  const timer = setInterval(() => {
    if (!isLeader()) return;
    void runDueSchedules(new Date());
  }, 60_000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
