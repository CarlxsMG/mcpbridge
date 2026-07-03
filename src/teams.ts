import { getDb } from "./db/connection.js";

/**
 * Team multi-tenancy: teams own clients, and admin users belong to a team.
 * A user with a team (teamId set) is *scoped* — they can only see and mutate
 * clients owned by their team. A user with no team (teamId null) is a
 * super-admin over tenancy: they see everything and can (re)assign ownership.
 * Bearer/API-key callers are always treated as super-admin (teamId undefined),
 * so existing CI/integrations are unaffected.
 *
 * v1 scopes clients (and, transitively, their tools). Bundles/consumers extend
 * the same team_id + canAccess pattern.
 */

export interface Team {
  id: number;
  name: string;
  createdAt: number;
  createdBy: string | null;
}

interface TeamRow {
  id: number;
  name: string;
  created_at: number;
  created_by: string | null;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/;

function rowTo(r: TeamRow): Team {
  return { id: r.id, name: r.name, createdAt: r.created_at, createdBy: r.created_by };
}

export function listTeams(): Team[] {
  return (getDb().query(`SELECT id, name, created_at, created_by FROM teams ORDER BY name`).all() as TeamRow[]).map(
    rowTo,
  );
}

export function getTeam(id: number): Team | null {
  const r = getDb().query(`SELECT id, name, created_at, created_by FROM teams WHERE id = ?`).get(id) as TeamRow | null;
  return r ? rowTo(r) : null;
}

export type TeamError = "INVALID_NAME" | "ALREADY_EXISTS";

export function createTeam(name: string, actor: string | null): Team | TeamError {
  if (!NAME_RE.test(name)) return "INVALID_NAME";
  const db = getDb();
  if (db.query(`SELECT 1 FROM teams WHERE name = ?`).get(name)) return "ALREADY_EXISTS";
  const now = Date.now();
  const r = db
    .query(
      `INSERT INTO teams (name, created_at, created_by) VALUES (?, ?, ?) RETURNING id, name, created_at, created_by`,
    )
    .get(name, now, actor) as TeamRow;
  return rowTo(r);
}

/** Deletes a team; clients/users owned by it are set back to unowned (FK ON DELETE SET NULL). */
export function deleteTeam(id: number): boolean {
  return getDb().query(`DELETE FROM teams WHERE id = ?`).run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Ownership + membership
// ---------------------------------------------------------------------------

/** The team id owning a client (null = unowned). Undefined when the client doesn't exist. */
export function getClientTeam(clientName: string): number | null | undefined {
  const r = getDb().query(`SELECT team_id FROM clients WHERE name = ?`).get(clientName) as {
    team_id: number | null;
  } | null;
  return r ? r.team_id : undefined;
}

/** Assigns (or, with null, clears) a client's owning team. Returns false for an unknown client/team. */
export function setClientTeam(clientName: string, teamId: number | null): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM clients WHERE name = ?`).get(clientName)) return false;
  if (teamId !== null && !db.query(`SELECT 1 FROM teams WHERE id = ?`).get(teamId)) return false;
  return (
    db.query(`UPDATE clients SET team_id = ?, updated_at = ? WHERE name = ?`).run(teamId, Date.now(), clientName)
      .changes > 0
  );
}

/** Assigns (or clears) a user's team membership. Returns false for an unknown user/team. */
export function setUserTeam(username: string, teamId: number | null): boolean {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM admin_users WHERE username = ?`).get(username)) return false;
  if (teamId !== null && !db.query(`SELECT 1 FROM teams WHERE id = ?`).get(teamId)) return false;
  return (
    db.query(`UPDATE admin_users SET team_id = ?, updated_at = ? WHERE username = ?`).run(teamId, Date.now(), username)
      .changes > 0
  );
}

// ---------------------------------------------------------------------------
// Access decision
// ---------------------------------------------------------------------------

/**
 * Whether a caller may access a client.
 *   - undefined callerTeam (bearer/API key) -> always (super-admin).
 *   - null callerTeam (session user with no team) -> always (super-admin).
 *   - a team id -> only clients owned by that same team.
 */
export function canAccessClient(callerTeamId: number | null | undefined, clientTeamId: number | null): boolean {
  if (callerTeamId === undefined || callerTeamId === null) return true;
  return clientTeamId === callerTeamId;
}
