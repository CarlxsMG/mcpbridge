import { getDb } from "../../db/connection.js";
import { config } from "../../config.js";
import { sha256Hex } from "../../lib/crypto.js";
import { dispatchWebhook } from "../../lib/webhook.js";
import { clampLimit, keysetPaginate } from "../../lib/pagination-cursor.js";
import type { Request } from "express";

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
  /** Tamper-evidence chain hash (null for rows written before the hash-chain migration). */
  hash: string | null;
}

/**
 * Content hash of one audit row, chained to the previous row's hash. Any edit to
 * a historical row (or a deleted/inserted row) breaks every subsequent hash, so
 * verifyAuditChain() can detect tampering.
 *
 * The pre-image is a JSON-encoded field tuple, NOT a raw `"\n".join`: `target`
 * and `detail` are caller-influenced and may contain newlines, and a bare
 * newline join is not injective — e.g. action `"a\nb"` + target `"c"` and action
 * `"a"` + target `"b\nc"` serialize to the same joined string, so two distinct
 * logical rows could share a hash. JSON.stringify escapes newlines/quotes inside
 * each element and delimits with structure, making the commitment injective
 * (and it distinguishes a null detail from an empty-string one).
 */
function computeAuditHash(
  prevHash: string,
  actor: string,
  action: string,
  target: string,
  detailJson: string | null,
  createdAt: number,
): string {
  return sha256Hex(JSON.stringify([prevHash, actor, action, target, detailJson, createdAt]));
}

/**
 * Best-effort delivery of an audit event to an external sink (SIEM), when
 * AUDIT_SINK_URL is set. Fire-and-forget: never blocks or fails the request.
 */
function streamAuditEvent(event: {
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
  hash: string;
}): void {
  const url = config.auditSinkUrl;
  if (!url) return;
  void dispatchWebhook(url, event, {
    timeoutMs: config.auditSinkTimeoutMs,
    rejectedLogMessage: "Audit sink URL rejected",
    failedLogMessage: "Audit sink delivery failed",
  });
}

/** Resolves a stable actor label from the request's auth context — never logs raw secrets. */
export function actorFromRequest(req: Request): string {
  const ctx = req.authContext;
  if (ctx?.method === "session" && ctx.username) return ctx.username;
  return "bearer:admin-api-key";
}

/**
 * Records an admin mutation for the audit log. Fire-and-forget from the
 * caller's perspective (synchronous — bun:sqlite has no async story), but
 * failures are swallowed with a log line rather than failing the request:
 * an audit-write hiccup should never block the actual admin action it's
 * describing.
 */
export function recordAudit(actor: string, action: string, target: string, detail?: Record<string, unknown>): void {
  try {
    const db = getDb();
    const createdAt = Date.now();
    const detailJson = detail ? JSON.stringify(detail) : null;
    // Read the tip of the chain and insert atomically so the (prev_hash, hash)
    // linkage is consistent. BEGIN IMMEDIATE takes the write lock up front — before
    // the tip SELECT — so in an HA / multi-instance deployment two concurrent
    // writers can't both read the same tip and fork the chain off one prev_hash
    // (which verifyAuditChain would later flag as tampering); the second serializes
    // behind the first. A single process was already safe (bun:sqlite is sync).
    const hash = db
      .transaction(() => {
        const prev = db
          .query(`SELECT hash FROM admin_audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`)
          .get() as { hash: string } | null;
        const prevHash = prev?.hash ?? "";
        const h = computeAuditHash(prevHash, actor, action, target, detailJson, createdAt);
        db.query(
          `INSERT INTO admin_audit_log (actor, action, target, detail_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(actor, action, target, detailJson, createdAt, prevHash, h);
        return h;
      })
      .immediate();
    streamAuditEvent({ actor, action, target, detail: detail ?? null, createdAt, hash });
  } catch {
    // Best-effort — never let audit logging break the request it's describing.
  }
}

/**
 * Tenancy scope for a team-bound caller: matches rows whose `target` is either
 * exactly one of the caller's team's client names (e.g. `client.enable`'s
 * target) or a `clientName__toolName` composite key owned by one of them (e.g.
 * `tool.disable`/`traffic.replay`'s target) — the same two target shapes
 * `ensureClientAccess`'s callers already special-case elsewhere. `target` is a
 * free-form string across very different action types (policy ids, schedule
 * ids, catalog slugs, team ids, ...), so this can't be a clean join the way
 * `traffic.tool_call_log.client_name` is; it deliberately only *recognizes*
 * client-owned targets and hides everything else from a team-scoped caller
 * rather than risk a false-positive cross-tenant match — fail-closed, not a
 * complete per-action-type mapping.
 */
function teamScopeCondition(
  conditions: string[],
  params: (string | number)[],
  teamId: number | null | undefined,
): void {
  if (typeof teamId !== "number") return;
  conditions.push(
    `EXISTS (SELECT 1 FROM clients c WHERE c.team_id = ? AND (target = c.name OR substr(target, 1, length(c.name) + 2) = c.name || '__'))`,
  );
  params.push(teamId);
}

/**
 * Walks the hash chain (rows written since the hash-chain migration) and returns
 * the first inconsistency, if any: a broken prev_hash linkage or a row whose
 * recomputed content hash doesn't match its stored hash — either of which means
 * the log was edited, reordered, or had rows inserted/deleted out of band.
 */
export function verifyAuditChain(): { ok: boolean; checked: number; brokenAtId?: number } {
  const rows = getDb()
    .query(
      `SELECT id, actor, action, target, detail_json, created_at, prev_hash, hash FROM admin_audit_log WHERE hash IS NOT NULL ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    actor: string;
    action: string;
    target: string;
    detail_json: string | null;
    created_at: number;
    prev_hash: string | null;
    hash: string;
  }[];
  let prevHash = "";
  let checked = 0;
  for (const r of rows) {
    if ((r.prev_hash ?? "") !== prevHash) return { ok: false, checked, brokenAtId: r.id };
    const expected = computeAuditHash(prevHash, r.actor, r.action, r.target, r.detail_json, r.created_at);
    if (expected !== r.hash) return { ok: false, checked, brokenAtId: r.id };
    prevHash = r.hash;
    checked++;
  }
  return { ok: true, checked };
}

export function listAuditLog(
  opts: {
    actor?: string;
    action?: string;
    from?: number;
    to?: number;
    cursor?: string;
    limit?: number;
    /** Tenancy scope — see {@link teamScopeCondition}. A number restricts to the caller's team's clients; undefined/null (super-admin/bearer) sees everything. */
    teamId?: number | null;
  } = {},
): {
  items: AuditLogEntry[];
  nextCursor?: string;
} {
  const db = getDb();
  const limit = clampLimit(opts.limit, 50, 200);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.cursor) {
    conditions.push("id < ?");
    params.push(Number(opts.cursor));
  }
  if (opts.actor) {
    conditions.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.action) {
    conditions.push("action = ?");
    params.push(opts.action);
  }
  if (opts.from !== undefined) {
    conditions.push("created_at >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("created_at <= ?");
    params.push(opts.to);
  }
  teamScopeCondition(conditions, params, opts.teamId);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `SELECT id, actor, action, target, detail_json, created_at, hash FROM admin_audit_log ${whereClause} ORDER BY id DESC`;

  return keysetPaginate<
    {
      id: number;
      actor: string;
      action: string;
      target: string;
      detail_json: string | null;
      created_at: number;
      hash: string | null;
    },
    AuditLogEntry
  >(
    db,
    sql,
    params,
    limit,
    (r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
      createdAt: r.created_at,
      hash: r.hash,
    }),
    (r) => r.id,
  );
}

/**
 * Distinct action values seen in the log so far, sorted alphabetically —
 * backs the admin-ui action filter's <select> (a practical, always-accurate
 * "known action types" list with zero maintenance burden, vs. hand-maintaining
 * an enum of every `recordAudit(..., "some.action", ...)` call site).
 */
export function listAuditActions(): string[] {
  const rows = getDb().query(`SELECT DISTINCT action FROM admin_audit_log ORDER BY action ASC`).all() as {
    action: string;
  }[];
  return rows.map((r) => r.action);
}

/** Bulk export of audit entries (up to `maxRows`) for download — same filters as listAuditLog, no pagination. */
export function exportAuditLog(
  opts: {
    actor?: string;
    action?: string;
    from?: number;
    to?: number;
    /** Tenancy scope — see {@link teamScopeCondition}. */
    teamId?: number | null;
  } = {},
  maxRows = 10000,
): AuditLogEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.actor) {
    conditions.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.action) {
    conditions.push("action = ?");
    params.push(opts.action);
  }
  if (opts.from !== undefined) {
    conditions.push("created_at >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("created_at <= ?");
    params.push(opts.to);
  }
  teamScopeCondition(conditions, params, opts.teamId);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT id, actor, action, target, detail_json, created_at, hash FROM admin_audit_log ${whereClause} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, clampLimit(maxRows, 10000, 100000)) as {
    id: number;
    actor: string;
    action: string;
    target: string;
    detail_json: string | null;
    created_at: number;
    hash: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
    hash: r.hash,
  }));
}
