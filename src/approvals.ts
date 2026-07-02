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
import { createHash } from "node:crypto";
import { getDb } from "./db/connection.js";
import { config } from "./config.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

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
  };
}

// ── Per-tool "requires approval" flag ───────────────────────────────────────

export function requiresApproval(clientName: string, toolName: string): boolean {
  const row = getDb()
    .query(`SELECT enabled FROM tool_approval WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { enabled: number } | null;
  return row?.enabled === 1;
}

/** Enables/disables the approval requirement for a tool. False when the tool is unknown. */
export function setApprovalRequired(clientName: string, toolName: string, enabled: boolean): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
  if (!exists) return false;
  if (!enabled) {
    db.query(`DELETE FROM tool_approval WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    return true;
  }
  db.query(
    `INSERT INTO tool_approval (client_name, tool_name, enabled, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(client_name, tool_name) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at`,
  ).run(clientName, toolName, Date.now());
  return true;
}

// ── Ticket lifecycle ────────────────────────────────────────────────────────

/** Order-insensitive hash of the call args, excluding the control keys. */
export function approvalArgsHash(args: Record<string, unknown>): string {
  const clean: Record<string, unknown> = { ...args };
  delete clean.__approval_id;
  delete clean.__confirm;
  return createHash("sha256").update(stableStringify(clean)).digest("hex");
}

export function createApproval(
  clientName: string,
  toolName: string,
  argsHash: string,
  argsJson: string,
  requestedBy: number | null,
): number {
  const r = getDb()
    .query(
      `INSERT INTO approvals (client_name, tool_name, args_hash, args_json, status, created_at, requested_by)
       VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING id`,
    )
    .get(clientName, toolName, argsHash, argsJson, Date.now(), requestedBy) as { id: number };
  return r.id;
}

export function getApproval(id: number): ApprovalRecord | null {
  const row = getDb().query(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | null;
  return row ? rowTo(row) : null;
}

export function listApprovals(status?: ApprovalStatus): ApprovalRecord[] {
  const rows = status
    ? (getDb().query(`SELECT * FROM approvals WHERE status = ? ORDER BY id DESC`).all(status) as ApprovalRow[])
    : (getDb().query(`SELECT * FROM approvals ORDER BY id DESC LIMIT 500`).all() as ApprovalRow[]);
  return rows.map(rowTo);
}

/** Records an admin decision. False if the ticket doesn't exist or isn't pending. */
export function decideApproval(id: number, status: "approved" | "rejected", decidedBy: string, note: string | null): boolean {
  const r = getDb()
    .query(`UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`)
    .run(status, Date.now(), decidedBy, note, id);
  return r.changes > 0;
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
  if (rec.status === "rejected") return { ok: false, message: `Approval #${id} was rejected${rec.note ? `: ${rec.note}` : ""}` };
  if (rec.consumedAt !== null) return { ok: false, message: `Approval #${id} was already used` };
  getDb().query(`UPDATE approvals SET consumed_at = ? WHERE id = ?`).run(Date.now(), id);
  return { ok: true };
}

/** Fire-and-forget notification to an operator-configured webhook (trusted env URL). */
export function notifyApproval(id: number, clientName: string, toolName: string): void {
  const url = config.approvalWebhookUrl;
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "approval_requested", id, client: clientName, tool: toolName }),
    signal: AbortSignal.timeout(config.approvalWebhookTimeoutMs),
  }).catch(() => {});
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
