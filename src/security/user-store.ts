import { getDb } from "../db/connection.js";

export type AdminRole = "admin" | "operator" | "auditor" | "viewer";

export const ADMIN_ROLES: AdminRole[] = ["admin", "operator", "auditor", "viewer"];

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === "string" && (ADMIN_ROLES as string[]).includes(v);
}

export interface AdminUser {
  id: number;
  username: string;
  passwordHash: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  createdBy: string | null;
  /** Owning team id, or null for a super-admin (tenancy-wide) user. */
  teamId: number | null;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  is_active: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  created_by: string | null;
  team_id: number | null;
}

function rowToUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as AdminRole,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    createdBy: row.created_by,
    teamId: row.team_id ?? null,
  };
}

export function countUsers(): number {
  const row = getDb().query(`SELECT COUNT(*) as count FROM admin_users`).get() as { count: number };
  return row.count;
}

/** Number of *active* users with the admin role — used to guard against locking out the last admin. */
export function countActiveAdmins(): number {
  const row = getDb()
    .query(`SELECT COUNT(*) as count FROM admin_users WHERE role = 'admin' AND is_active = 1`)
    .get() as { count: number };
  return row.count;
}

export function findUserByUsername(username: string): AdminUser | null {
  const row = getDb().query(`SELECT * FROM admin_users WHERE username = ?`).get(username) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function findUserById(id: number): AdminUser | null {
  const row = getDb().query(`SELECT * FROM admin_users WHERE id = ?`).get(id) as UserRow | null;
  return row ? rowToUser(row) : null;
}

export function listUsers(): AdminUser[] {
  const rows = getDb().query(`SELECT * FROM admin_users ORDER BY username`).all() as UserRow[];
  return rows.map(rowToUser);
}

export function createUser(
  username: string,
  passwordHash: string,
  role: AdminRole,
  createdBy: string | null,
): AdminUser {
  const db = getDb();
  const now = Date.now();
  const result = db
    .query(
      `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(username, passwordHash, role, now, now, createdBy);
  return findUserById(Number(result.lastInsertRowid))!;
}

export function touchLastLogin(userId: number): void {
  getDb().query(`UPDATE admin_users SET last_login_at = ? WHERE id = ?`).run(Date.now(), userId);
}

/** Updates role/active-state. Returns false for an unknown username. */
export function updateUser(username: string, patch: { role?: AdminRole; isActive?: boolean }): boolean {
  const existing = findUserByUsername(username);
  if (!existing) return false;
  const role = patch.role ?? existing.role;
  const isActive = patch.isActive ?? existing.isActive;
  const result = getDb()
    .query(`UPDATE admin_users SET role = ?, is_active = ?, updated_at = ? WHERE username = ?`)
    .run(role, isActive ? 1 : 0, Date.now(), username);
  return result.changes > 0;
}

export function updatePassword(username: string, passwordHash: string): boolean {
  const result = getDb()
    .query(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE username = ?`)
    .run(passwordHash, Date.now(), username);
  return result.changes > 0;
}

export function deleteUser(username: string): boolean {
  const result = getDb().query(`DELETE FROM admin_users WHERE username = ?`).run(username);
  return result.changes > 0;
}
