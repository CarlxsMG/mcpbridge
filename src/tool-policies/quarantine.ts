/**
 * Configurable auto-quarantine — escalates a tool after N *consecutive*
 * content-guardrail hits (see guardrails.ts) into a quarantined state, with
 * an admin-configurable action and recovery mode. Two tables, same idiom as
 * cache/guardrails: `tool_quarantine_policy` (admin config) and
 * `tool_quarantine_state` (runtime counters, persisted so it survives a
 * restart and is visible/auditable in the admin UI — unlike the circuit
 * breaker, which is intentionally ephemeral).
 *
 * Enforced inside proxyToolCall BEFORE the circuit breaker (rule 4, like
 * every other guard), so a blocked/force-approved call never burns a
 * half-open probe. The three actions:
 *   - "block": same backstop as an admin-disabled tool, but reported as a
 *     distinct quarantine state so the UI can explain WHY.
 *   - "force_approval": the call is routed through the same ticket-based
 *     approval gate approvals.ts already provides, even if the tool doesn't
 *     normally require approval.
 *   - "observe": the call proceeds; only a log line + metric mark it.
 */
import { getDb } from "../db/connection.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export type QuarantineAction = "block" | "force_approval" | "observe";
export type QuarantineRecoveryMode = "auto" | "manual";

export interface QuarantinePolicy {
  consecutiveThreshold: number;
  action: QuarantineAction;
  recoveryMode: QuarantineRecoveryMode;
  cooldownMs: number | null;
}

export interface QuarantineState {
  quarantined: boolean;
  consecutiveHits: number;
  quarantinedAt: number | null;
  reason: string | null;
  cooldownUntil: number | null;
}

interface PolicyRow {
  consecutive_threshold: number;
  action: string;
  recovery_mode: string;
  cooldown_ms: number | null;
}

interface StateRow {
  quarantined: number;
  consecutive_hits: number;
  quarantined_at: number | null;
  reason: string | null;
  cooldown_until: number | null;
}

const EMPTY_STATE: QuarantineState = {
  quarantined: false,
  consecutiveHits: 0,
  quarantinedAt: null,
  reason: null,
  cooldownUntil: null,
};

/** Injectable clock so cooldown expiry is deterministically testable. */
let nowFn: () => number = () => Date.now();

function rowToPolicy(row: PolicyRow): QuarantinePolicy {
  return {
    consecutiveThreshold: row.consecutive_threshold,
    action: row.action as QuarantineAction,
    recoveryMode: row.recovery_mode as QuarantineRecoveryMode,
    cooldownMs: row.cooldown_ms,
  };
}

function rowToState(row: StateRow): QuarantineState {
  return {
    quarantined: row.quarantined === 1,
    consecutiveHits: row.consecutive_hits,
    quarantinedAt: row.quarantined_at,
    reason: row.reason,
    cooldownUntil: row.cooldown_until,
  };
}

export function getQuarantinePolicy(clientName: string, toolName: string): QuarantinePolicy | null {
  const row = getDb()
    .query(
      `SELECT consecutive_threshold, action, recovery_mode, cooldown_ms FROM tool_quarantine_policy WHERE client_name = ? AND tool_name = ?`,
    )
    .get(clientName, toolName) as PolicyRow | null;
  return row ? rowToPolicy(row) : null;
}

export function getQuarantineState(clientName: string, toolName: string): QuarantineState {
  const row = getDb()
    .query(
      `SELECT quarantined, consecutive_hits, quarantined_at, reason, cooldown_until FROM tool_quarantine_state WHERE client_name = ? AND tool_name = ?`,
    )
    .get(clientName, toolName) as StateRow | null;
  return row ? rowToState(row) : EMPTY_STATE;
}

/**
 * Persists (or clears, with `null`) a tool's quarantine policy. Clearing the
 * policy also drops any accumulated state — with no policy there's nothing
 * left to escalate or recover from. Returns false when the tool is unknown.
 */
export function setQuarantinePolicy(clientName: string, toolName: string, input: QuarantinePolicy | null): boolean {
  if (!toolExists(clientName, toolName)) return false;
  const db = getDb();

  if (input === null) {
    db.query(`DELETE FROM tool_quarantine_policy WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    db.query(`DELETE FROM tool_quarantine_state WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }

  upsertConfig(
    "tool_quarantine_policy",
    { client_name: clientName, tool_name: toolName },
    {
      consecutive_threshold: input.consecutiveThreshold,
      action: input.action,
      recovery_mode: input.recoveryMode,
      cooldown_ms: input.cooldownMs,
    },
    nowFn(),
  );
  return true;
}

function ensureStateRow(clientName: string, toolName: string): void {
  getDb()
    .query(
      `INSERT INTO tool_quarantine_state (client_name, tool_name, quarantined, consecutive_hits)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(client_name, tool_name) DO NOTHING`,
    )
    .run(clientName, toolName);
}

/**
 * Called from both existing guardrail checkpoints (input-block and
 * output-flag) in proxy.ts. A hit increments the consecutive counter and, on
 * crossing the policy's threshold, quarantines the tool. A clean pass resets
 * the counter — quarantine escalation only cares about a consecutive streak,
 * not a lifetime count. A clean pass never lifts an ALREADY-active
 * quarantine; only cooldown expiry (checked lazily by `checkQuarantine`) or a
 * manual clear does that.
 */
export function recordGuardrailHit(clientName: string, toolName: string, hit: boolean): void {
  const policy = getQuarantinePolicy(clientName, toolName);
  if (!policy) return; // no policy configured -> nothing to escalate

  ensureStateRow(clientName, toolName);
  const db = getDb();
  const now = nowFn();

  if (!hit) {
    db.query(`UPDATE tool_quarantine_state SET consecutive_hits = 0 WHERE client_name = ? AND tool_name = ?`).run(
      clientName,
      toolName,
    );
    return;
  }

  const state = getQuarantineState(clientName, toolName);
  const consecutiveHits = state.consecutiveHits + 1;
  if (consecutiveHits >= policy.consecutiveThreshold) {
    const cooldownUntil = policy.recoveryMode === "auto" && policy.cooldownMs ? now + policy.cooldownMs : null;
    db.query(
      `UPDATE tool_quarantine_state SET consecutive_hits = ?, quarantined = 1, quarantined_at = ?, reason = ?, cooldown_until = ? WHERE client_name = ? AND tool_name = ?`,
    ).run(
      consecutiveHits,
      now,
      `${consecutiveHits} consecutive guardrail violations`,
      cooldownUntil,
      clientName,
      toolName,
    );
  } else {
    db.query(`UPDATE tool_quarantine_state SET consecutive_hits = ? WHERE client_name = ? AND tool_name = ?`).run(
      consecutiveHits,
      clientName,
      toolName,
    );
  }
}

export interface QuarantineCheck {
  active: boolean;
  action?: QuarantineAction;
  reason?: string;
}

/**
 * The dispatch-time gate. Lazily clears an auto-recovery quarantine once its
 * cooldown has elapsed (same idiom as response-cache's TTL expiry — no
 * background timer needed).
 */
export function checkQuarantine(clientName: string, toolName: string): QuarantineCheck {
  const policy = getQuarantinePolicy(clientName, toolName);
  if (!policy) return { active: false };
  const state = getQuarantineState(clientName, toolName);
  if (!state.quarantined) return { active: false };

  if (policy.recoveryMode === "auto" && state.cooldownUntil !== null && nowFn() >= state.cooldownUntil) {
    clearQuarantine(clientName, toolName);
    return { active: false };
  }

  return { active: true, action: policy.action, reason: state.reason ?? undefined };
}

/** Manual (or lazy-auto) reset of a tool's quarantine state. False when the tool is unknown. */
export function clearQuarantine(clientName: string, toolName: string): boolean {
  if (!toolExists(clientName, toolName)) return false;
  const db = getDb();
  db.query(
    `UPDATE tool_quarantine_state SET quarantined = 0, consecutive_hits = 0, quarantined_at = NULL, reason = NULL, cooldown_until = NULL WHERE client_name = ? AND tool_name = ?`,
  ).run(clientName, toolName);
  return true;
}

/** Policy+state for every tool of a client, keyed by tool name (batched for detail views). */
export function getQuarantineForClient(
  clientName: string,
): Record<string, { policy: QuarantinePolicy; state: QuarantineState }> {
  const db = getDb();
  const policyRows = db
    .query(
      `SELECT tool_name, consecutive_threshold, action, recovery_mode, cooldown_ms FROM tool_quarantine_policy WHERE client_name = ?`,
    )
    .all(clientName) as (PolicyRow & { tool_name: string })[];
  const stateRows = db
    .query(
      `SELECT tool_name, quarantined, consecutive_hits, quarantined_at, reason, cooldown_until FROM tool_quarantine_state WHERE client_name = ?`,
    )
    .all(clientName) as (StateRow & { tool_name: string })[];
  const stateByTool = new Map(stateRows.map((r) => [r.tool_name, rowToState(r)]));

  const out: Record<string, { policy: QuarantinePolicy; state: QuarantineState }> = {};
  for (const r of policyRows) {
    out[r.tool_name] = { policy: rowToPolicy(r), state: stateByTool.get(r.tool_name) ?? EMPTY_STATE };
  }
  return out;
}

/** Test-only: override (or reset with null) the clock used for cooldown expiry. */
export function __setClockForTesting(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}
