import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { safeCompare } from "./compare.js";
import { findUserById } from "./user-store.js";
import type { AdminRole } from "./user-store.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export interface SessionContext {
  userId: number;
  username: string;
  role: AdminRole;
  csrfToken: string;
}

export interface SessionSummary {
  id: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/** Creates a new session row and returns the raw (never-persisted) token + CSRF token to hand back to the client. */
export function createSession(userId: number, ip: string | undefined, userAgent: string | undefined): CreatedSession {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + config.sessionAbsoluteTtlMs;

  getDb()
    .query(
      `INSERT INTO admin_sessions (user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, hashToken(token), csrfToken, now, now, expiresAt, ip ?? null, userAgent ?? null);

  return { token, csrfToken, expiresAt };
}

/**
 * Validates a raw session token from the cookie: checks revocation, absolute
 * expiry, and idle timeout, then touches `last_seen_at` (sliding window) on
 * success. Returns null for anything invalid — callers must treat every
 * failure mode identically (401), never reveal which check failed.
 */
export function validateSession(token: string): SessionContext | null {
  const db = getDb();
  const hash = hashToken(token);
  const row = db.query(`SELECT * FROM admin_sessions WHERE token_hash = ?`).get(hash) as SessionRow | null;
  if (!row) return null;
  // Indexed-lookup timing isn't the same leak shape as the linear API-key scan
  // that motivated safeCompare elsewhere, but this keeps "every credential
  // comparison is constant-time" true without exception, for one extra line.
  if (!safeCompare(row.token_hash, hash)) return null;

  const now = Date.now();
  if (row.revoked_at !== null) return null;
  if (row.expires_at < now) return null;
  if (now - row.last_seen_at > config.sessionIdleTimeoutMs) return null;

  const user = findUserById(row.user_id);
  if (!user || !user.isActive) return null;

  db.query(`UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?`).run(now, row.id);

  return { userId: user.id, username: user.username, role: user.role, csrfToken: row.csrf_token };
}

export function revokeSession(token: string): void {
  const hash = hashToken(token);
  getDb().query(`UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`).run(Date.now(), hash);
}

/** Revokes every active session for a user — called on password change, deactivation, and deletion. */
export function revokeAllSessionsForUser(userId: number): void {
  getDb().query(`UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(Date.now(), userId);
}

export function listActiveSessionsForUser(userId: number): SessionSummary[] {
  const now = Date.now();
  const rows = getDb()
    .query(
      `SELECT id, created_at, last_seen_at, expires_at, ip_address, user_agent
       FROM admin_sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC`
    )
    .all(userId, now) as {
    id: number;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
    ip_address: string | null;
    user_agent: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  }));
}

/** Revokes a specific session by id, scoped to the owning user (can't revoke someone else's session). */
export function revokeSessionById(userId: number, sessionId: number): boolean {
  const result = getDb()
    .query(`UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .run(Date.now(), sessionId, userId);
  return result.changes > 0;
}
