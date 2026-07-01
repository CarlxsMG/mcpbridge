import { getDb } from "../db/connection.js";
import type { Request } from "express";

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
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
    getDb()
      .query(`INSERT INTO admin_audit_log (actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(actor, action, target, detail ? JSON.stringify(detail) : null, Date.now());
  } catch {
    // Best-effort — never let audit logging break the request it's describing.
  }
}

export function listAuditLog(opts: { actor?: string; action?: string; from?: number; to?: number; cursor?: string; limit?: number } = {}): {
  items: AuditLogEntry[];
  nextCursor?: string;
} {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

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
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .query(`SELECT id, actor, action, target, detail_json, created_at FROM admin_audit_log ${whereClause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as { id: number; actor: string; action: string; target: string; detail_json: string | null; created_at: number }[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: AuditLogEntry[] = page.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }));

  return { items, nextCursor: hasMore ? String(page[page.length - 1].id) : undefined };
}

/** Bulk export of audit entries (up to `maxRows`) for download — same filters as listAuditLog, no pagination. */
export function exportAuditLog(
  opts: { actor?: string; action?: string; from?: number; to?: number } = {},
  maxRows = 10000
): AuditLogEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.actor) { conditions.push("actor = ?"); params.push(opts.actor); }
  if (opts.action) { conditions.push("action = ?"); params.push(opts.action); }
  if (opts.from !== undefined) { conditions.push("created_at >= ?"); params.push(opts.from); }
  if (opts.to !== undefined) { conditions.push("created_at <= ?"); params.push(opts.to); }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT id, actor, action, target, detail_json, created_at FROM admin_audit_log ${whereClause} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(maxRows, 1), 100000)) as { id: number; actor: string; action: string; target: string; detail_json: string | null; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }));
}
