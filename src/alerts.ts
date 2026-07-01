import { getDb } from "./db/connection.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { registry } from "./registry.js";
import { getAllCircuitStates } from "./circuit-breaker.js";
import { getUsageSummary } from "./observability/usage.js";
import { detectUsageSpike } from "./observability/anomaly.js";
import { validateBackendUrl } from "./security/ip-validator.js";
import { isLeader } from "./db/leader-lease.js";

export type AlertEventType = "circuit_breaker_open" | "client_unreachable" | "error_rate" | "usage_spike";

export const ALERT_EVENT_TYPES: AlertEventType[] = ["circuit_breaker_open", "client_unreachable", "error_rate", "usage_spike"];

export interface AlertRule {
  id: number;
  name: string;
  eventType: AlertEventType;
  enabled: boolean;
  webhookUrl: string;
  threshold: number | null;
  minCalls: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

interface AlertRow {
  id: number;
  name: string;
  event_type: string;
  enabled: number;
  webhook_url: string;
  threshold: number | null;
  min_calls: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

const COLS = "id, name, event_type, enabled, webhook_url, threshold, min_calls, last_fired_at, created_at, updated_at, created_by";

function rowToRule(row: AlertRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    eventType: row.event_type as AlertEventType,
    enabled: row.enabled === 1,
    webhookUrl: row.webhook_url,
    threshold: row.threshold,
    minCalls: row.min_calls,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

// Edge-trigger memory: only fire when a condition transitions false -> true, so
// a persistently-open breaker doesn't spam the webhook every interval.
const lastState = new Map<number, boolean>();

export function listAlertRules(): AlertRule[] {
  return (getDb().query(`SELECT ${COLS} FROM alert_rules ORDER BY id DESC`).all() as AlertRow[]).map(rowToRule);
}

export function getAlertRule(id: number): AlertRule | null {
  if (!Number.isInteger(id)) return null;
  const row = getDb().query(`SELECT ${COLS} FROM alert_rules WHERE id = ?`).get(id) as AlertRow | null;
  return row ? rowToRule(row) : null;
}

export function createAlertRule(input: {
  name: string;
  eventType: AlertEventType;
  webhookUrl: string;
  threshold?: number | null;
  minCalls?: number | null;
  actor: string | null;
}): AlertRule {
  const now = Date.now();
  const row = getDb()
    .query(
      `INSERT INTO alert_rules (name, event_type, enabled, webhook_url, threshold, min_calls, created_at, updated_at, created_by)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLS}`
    )
    .get(input.name, input.eventType, input.webhookUrl, input.threshold ?? null, input.minCalls ?? null, now, now, input.actor) as AlertRow;
  return rowToRule(row);
}

export function updateAlertRule(
  id: number,
  updates: { name?: string; enabled?: boolean; webhookUrl?: string; threshold?: number | null; minCalls?: number | null }
): AlertRule | null {
  const existing = getAlertRule(id);
  if (!existing) return null;
  const name = updates.name ?? existing.name;
  const enabled = updates.enabled ?? existing.enabled;
  const webhookUrl = updates.webhookUrl ?? existing.webhookUrl;
  const threshold = updates.threshold !== undefined ? updates.threshold : existing.threshold;
  const minCalls = updates.minCalls !== undefined ? updates.minCalls : existing.minCalls;
  getDb()
    .query(`UPDATE alert_rules SET name = ?, enabled = ?, webhook_url = ?, threshold = ?, min_calls = ?, updated_at = ? WHERE id = ?`)
    .run(name, enabled ? 1 : 0, webhookUrl, threshold, minCalls, Date.now(), id);
  return getAlertRule(id);
}

export function deleteAlertRule(id: number): boolean {
  lastState.delete(id);
  return getDb().query(`DELETE FROM alert_rules WHERE id = ?`).run(id).changes > 0;
}

interface ConditionResult {
  active: boolean;
  detail: Record<string, unknown>;
}

function evaluateCondition(rule: AlertRule): ConditionResult {
  switch (rule.eventType) {
    case "client_unreachable": {
      const clients = registry.listClients().filter((c) => c.status === "unreachable").map((c) => c.name);
      return { active: clients.length > 0, detail: { clients } };
    }
    case "circuit_breaker_open": {
      const open = Object.entries(getAllCircuitStates()).filter(([, s]) => s === "open").map(([n]) => n);
      return { active: open.length > 0, detail: { clients: open } };
    }
    case "error_rate": {
      const summary = getUsageSummary({ from: Date.now() - config.alertErrorRateWindowMs });
      const threshold = rule.threshold ?? 0.5;
      const minCalls = rule.minCalls ?? 10;
      const active = summary.calls >= minCalls && summary.errorRate >= threshold;
      return { active, detail: { errorRate: summary.errorRate, calls: summary.calls, threshold, minCalls } };
    }
    case "usage_spike": {
      // threshold = spike factor (recent rate >= factor x baseline rate);
      // minCalls = minimum recent calls before a spike can fire.
      const factor = rule.threshold ?? 3;
      const minCalls = rule.minCalls ?? 20;
      const r = detectUsageSpike({ factor, minCalls });
      return {
        active: r.spike,
        detail: { recentCalls: r.recentCalls, recentRatePerMin: Math.round(r.recentRate * 100) / 100, baselineRatePerMin: Math.round(r.baselineRate * 100) / 100, factor, minCalls },
      };
    }
    default:
      return { active: false, detail: {} };
  }
}

async function dispatchWebhook(rule: AlertRule, detail: Record<string, unknown>): Promise<boolean> {
  const validation = await validateBackendUrl(rule.webhookUrl, config.allowPrivateIps, config.allowedHosts);
  if (!validation.valid) {
    log("warn", "Alert webhook URL rejected", { rule: rule.name, reason: validation.reason });
    return false;
  }
  try {
    await fetch(rule.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: rule.eventType, rule: rule.name, detail, timestamp: Date.now() }),
      redirect: "error",
      signal: AbortSignal.timeout(config.alertWebhookTimeoutMs),
    });
    return true;
  } catch (err) {
    log("warn", "Alert webhook delivery failed", { rule: rule.name, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function markFired(id: number): void {
  try {
    getDb().query(`UPDATE alert_rules SET last_fired_at = ? WHERE id = ?`).run(Date.now(), id);
  } catch {
    // best-effort
  }
}

/** Evaluates every enabled rule and dispatches webhooks for newly-active conditions. */
export async function evaluateAlerts(): Promise<void> {
  for (const rule of listAlertRules()) {
    if (!rule.enabled) {
      lastState.delete(rule.id);
      continue;
    }
    const { active, detail } = evaluateCondition(rule);
    const was = lastState.get(rule.id) ?? false;
    if (active && !was) {
      lastState.set(rule.id, true);
      await dispatchWebhook(rule, detail);
      markFired(rule.id);
    } else if (!active && was) {
      lastState.set(rule.id, false);
    }
  }
}

/** Sends a one-off test payload to a rule's webhook, ignoring its condition. */
export async function sendTestAlert(id: number): Promise<{ ok: boolean; reason?: string }> {
  const rule = getAlertRule(id);
  if (!rule) return { ok: false, reason: "not found" };
  const ok = await dispatchWebhook(rule, { test: true });
  return { ok };
}

/** Starts the periodic (leader-only) alert evaluation loop. Returns a stop function. */
export function startAlertLoop(): () => void {
  const timer = setInterval(() => {
    if (!isLeader()) return;
    evaluateAlerts().catch((err) => log("warn", "Alert evaluation failed", { error: err instanceof Error ? err.message : String(err) }));
  }, config.alertIntervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/** Test-only: clears edge-trigger memory. */
export function __resetAlertStateForTesting(): void {
  lastState.clear();
}
