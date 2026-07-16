/**
 * Human-in-the-loop approval for high-risk tools ("ticket" model).
 *
 * MCP is a synchronous request/response protocol, so a call can't block waiting
 * for a human. Instead, when a tool requires approval and the call carries no
 * `__approval_id`, the proxy files a PENDING approval (bound to a hash of the
 * exact arguments), notifies an operator webhook, and returns the ticket id. An
 * admin approves/rejects it; the caller then re-invokes with
 * `{"__approval_id": <id>}`. The ticket is single-use and bound to those exact
 * args, so an approval can't be replayed or reused for a different payload.
 *
 * Extends the destructive-gating idea of `tool-sensitivity` (which uses an inline
 * `__confirm`); approval adds an out-of-band human decision on top.
 */
import { getDb } from "../../db/connection.js";
import { config } from "../../config.js";
import { sha256Hex } from "../../lib/crypto.js";
import { dispatchWebhook } from "../../lib/webhook.js";
import { stableStringify } from "../../lib/stable-json.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalDecision {
  id: number;
  approvalId: number;
  decidedBy: string;
  decision: "approved" | "rejected";
  note: string | null;
  decidedAt: number;
}

export interface ApprovalRecord {
  id: number;
  clientName: string;
  toolName: string;
  argsHash: string;
  argsJson: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
  consumedAt: number | null;
  requestedBy: number | null;
  /** N-of-M threshold snapshotted from the tool's config at ticket-creation time. */
  requiredLevels: number;
  /** Individual approve/reject decisions recorded so far (a reject is always terminal, alone). */
  decisions: ApprovalDecision[];
}

interface ApprovalRow {
  id: number;
  client_name: string;
  tool_name: string;
  args_hash: string;
  args_json: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  consumed_at: number | null;
  requested_by: number | null;
  required_levels: number;
}

interface DecisionRow {
  id: number;
  approval_id: number;
  decided_by: string;
  decision: string;
  note: string | null;
  decided_at: number;
}

function rowToDecision(row: DecisionRow): ApprovalDecision {
  return {
    id: row.id,
    approvalId: row.approval_id,
    decidedBy: row.decided_by,
    decision: row.decision as "approved" | "rejected",
    note: row.note,
    decidedAt: row.decided_at,
  };
}

function listDecisions(approvalId: number): ApprovalDecision[] {
  return (
    getDb()
      .query(`SELECT * FROM approval_decisions WHERE approval_id = ? ORDER BY id ASC`)
      .all(approvalId) as DecisionRow[]
  ).map(rowToDecision);
}

function rowTo(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    clientName: row.client_name,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    argsJson: row.args_json,
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note,
    consumedAt: row.consumed_at,
    requestedBy: row.requested_by,
    requiredLevels: row.required_levels,
    decisions: listDecisions(row.id),
  };
}

// ── Per-tool "requires approval" flag ───────────────────────────────────────

export const MAX_APPROVAL_LEVELS = 10;

export function requiresApproval(clientName: string, toolName: string): boolean {
  const row = getDb()
    .query(`SELECT enabled FROM tool_approval WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { enabled: number } | null;
  return row?.enabled === 1;
}

/** N-of-M distinct-approver threshold configured for a tool. Defaults to 1 (today's single-approval behavior). */
export function getRequiredLevels(clientName: string, toolName: string): number {
  const row = getDb()
    .query(`SELECT required_levels FROM tool_approval WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { required_levels: number } | null;
  return row?.required_levels ?? 1;
}

/**
 * Enables/disables the approval requirement for a tool, and its N-of-M
 * distinct-approver threshold (defaults to 1, clamped to [1, MAX_APPROVAL_LEVELS]).
 * False when the tool is unknown.
 */
export function setApprovalRequired(
  clientName: string,
  toolName: string,
  enabled: boolean,
  requiredLevels?: number,
): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
  if (!exists) return false;
  if (!enabled) {
    db.query(`DELETE FROM tool_approval WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  const levels =
    requiredLevels !== undefined &&
    Number.isInteger(requiredLevels) &&
    requiredLevels >= 1 &&
    requiredLevels <= MAX_APPROVAL_LEVELS
      ? requiredLevels
      : (getRequiredLevels(clientName, toolName) ?? 1);
  db.query(
    `INSERT INTO tool_approval (client_name, tool_name, enabled, required_levels, updated_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(client_name, tool_name) DO UPDATE SET enabled = 1, required_levels = excluded.required_levels, updated_at = excluded.updated_at`,
  ).run(clientName, toolName, levels, Date.now());
  return true;
}

/** Approval config for every tool of a client, keyed by tool name (batched for detail views). */
export function getApprovalConfigForClient(
  clientName: string,
): Record<string, { required: boolean; requiredLevels: number }> {
  const rows = getDb()
    .query(`SELECT tool_name, enabled, required_levels FROM tool_approval WHERE client_name = ?`)
    .all(clientName) as { tool_name: string; enabled: number; required_levels: number }[];
  const out: Record<string, { required: boolean; requiredLevels: number }> = {};
  for (const r of rows) out[r.tool_name] = { required: r.enabled === 1, requiredLevels: r.required_levels };
  return out;
}

// ── Ticket lifecycle ────────────────────────────────────────────────────────

/** Order-insensitive hash of the call args, excluding the control keys. */
export function approvalArgsHash(args: Record<string, unknown>): string {
  const clean: Record<string, unknown> = { ...args };
  delete clean.__approval_id;
  delete clean.__confirm;
  return sha256Hex(stableStringify(clean));
}

export function createApproval(
  clientName: string,
  toolName: string,
  argsHash: string,
  argsJson: string,
  requestedBy: number | null,
  requiredLevels = 1,
): number {
  const r = getDb()
    .query(
      `INSERT INTO approvals (client_name, tool_name, args_hash, args_json, status, created_at, requested_by, required_levels)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING id`,
    )
    .get(clientName, toolName, argsHash, argsJson, Date.now(), requestedBy, requiredLevels) as { id: number };
  return r.id;
}

export function getApproval(id: number): ApprovalRecord | null {
  const row = getDb().query(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | null;
  return row ? rowTo(row) : null;
}

/**
 * Lists approval tickets, optionally filtered by status and/or scoped to a
 * team. `teamId` as a number restricts results to tickets whose client is
 * owned by that team (mirrors `listTraffic`'s `teamId` filter — a ticket's
 * `argsJson` carries the same kind of unredacted, potentially sensitive
 * payload traffic records do); null/undefined (super-admin session or bearer
 * caller) lists tickets for every team, matching prior behavior.
 */
export function listApprovals(status?: ApprovalStatus, teamId?: number | null): ApprovalRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (typeof teamId === "number") {
    where.push("client_name IN (SELECT name FROM clients WHERE team_id = ?)");
    params.push(teamId);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Preserve prior behavior: an unfiltered-by-status list caps at 500; a
  // status-filtered list does not.
  const limitClause = status ? "" : " LIMIT 500";
  const rows = getDb()
    .query(`SELECT * FROM approvals ${whereClause} ORDER BY id DESC${limitClause}`)
    .all(...params) as ApprovalRow[];
  return rows.map(rowTo);
}

export type DecideApprovalResult =
  | { ok: true; finalStatus: ApprovalStatus; approvalsReceived: number; requiredLevels: number }
  | { ok: false; message: string };

/**
 * Records an admin decision. A reject is an immediate terminal veto — one
 * rejection fails the whole ticket regardless of any prior approvals. An
 * approve is recorded as one of possibly several required distinct approvers
 * (enforced by `approval_decisions`'s UNIQUE(approval_id, decided_by)); the
 * ticket only flips to 'approved' once the count reaches the required N-of-M
 * threshold that was snapshotted on the ticket at creation time.
 */
export function decideApproval(
  id: number,
  status: "approved" | "rejected",
  decidedBy: string,
  note: string | null,
): DecideApprovalResult {
  const rec = getApproval(id);
  if (!rec) return { ok: false, message: `Approval #${id} not found` };
  if (rec.status !== "pending") return { ok: false, message: `Approval #${id} is no longer pending` };

  const db = getDb();
  const now = Date.now();

  if (status === "rejected") {
    // Record the decision FIRST: its UNIQUE(approval_id, decided_by) is the guard
    // against the same actor deciding twice (e.g. approve-then-reject). Catch that
    // violation the way the approve branch below does — the old order flipped the
    // ticket to 'rejected' and only THEN inserted, so a duplicate threw uncaught
    // after the status was already committed (route 500, and the reject audit
    // record was never written). If the insert fails we leave the ticket pending.
    try {
      db.query(
        `INSERT INTO approval_decisions (approval_id, decided_by, decision, note, decided_at) VALUES (?, ?, 'rejected', ?, ?)`,
      ).run(id, decidedBy, note, now);
    } catch {
      return { ok: false, message: `You already recorded a decision for approval #${id}` };
    }
    const r = db
      .query(
        `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(now, decidedBy, note, id);
    if (r.changes === 0) return { ok: false, message: `Approval #${id} is no longer pending` };
    return { ok: true, finalStatus: "rejected", approvalsReceived: 0, requiredLevels: rec.requiredLevels };
  }

  try {
    db.query(
      `INSERT INTO approval_decisions (approval_id, decided_by, decision, note, decided_at) VALUES (?, ?, 'approved', ?, ?)`,
    ).run(id, decidedBy, note, now);
  } catch {
    // UNIQUE(approval_id, decided_by) violation — this actor already recorded a decision.
    return { ok: false, message: `You already recorded a decision for approval #${id}` };
  }

  const approvedCount = (
    db
      .query(`SELECT COUNT(*) as c FROM approval_decisions WHERE approval_id = ? AND decision = 'approved'`)
      .get(id) as { c: number }
  ).c;
  if (approvedCount >= rec.requiredLevels) {
    db.query(
      `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`,
    ).run(now, decidedBy, note, id);
    return { ok: true, finalStatus: "approved", approvalsReceived: approvedCount, requiredLevels: rec.requiredLevels };
  }
  return { ok: true, finalStatus: "pending", approvalsReceived: approvedCount, requiredLevels: rec.requiredLevels };
}

/**
 * Validates a ticket for a call and, if usable, consumes it (single-use). The
 * ticket must exist, match this client/tool, match the args hash, be approved,
 * and be unused. Returns a caller-facing message on any failure.
 */
export function consumeApproval(
  id: number,
  clientName: string,
  toolName: string,
  argsHash: string,
): { ok: true } | { ok: false; message: string } {
  const rec = getApproval(id);
  if (!rec || rec.clientName !== clientName || rec.toolName !== toolName) {
    return { ok: false, message: `Approval #${id} not found for this tool` };
  }
  if (rec.argsHash !== argsHash) return { ok: false, message: `Approval #${id} was issued for different arguments` };
  if (rec.status === "pending") return { ok: false, message: `Approval #${id} is still pending` };
  if (rec.status === "rejected")
    return { ok: false, message: `Approval #${id} was rejected${rec.note ? `: ${rec.note}` : ""}` };
  if (rec.consumedAt !== null) return { ok: false, message: `Approval #${id} was already used` };
  // Atomic compare-and-swap: only the first caller whose UPDATE sees
  // consumed_at still NULL wins the single-use ticket. Without the `AND
  // consumed_at IS NULL` guard, two callers racing past the read above (a real
  // window under multi-instance HA, where the SELECT and UPDATE aren't one
  // transaction) would both mark it consumed and both proceed. Mirrors
  // decideApproval's `WHERE ... AND status = 'pending'` CAS idiom above.
  const r = getDb()
    .query(`UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .run(Date.now(), id);
  if (r.changes === 0) return { ok: false, message: `Approval #${id} was already used` };
  return { ok: true };
}

/** Fire-and-forget notification to an operator-configured webhook (trusted env URL). */
export function notifyApproval(id: number, clientName: string, toolName: string): void {
  const url = config.approvalWebhookUrl;
  if (!url) return;
  void dispatchWebhook(
    url,
    { type: "approval_requested", id, client: clientName, tool: toolName },
    {
      timeoutMs: config.approvalWebhookTimeoutMs,
      rejectedLogMessage: "Approval webhook URL rejected",
      failedLogMessage: "Approval webhook delivery failed",
      logContext: { approvalId: id, client: clientName, tool: toolName },
    },
  );
}
