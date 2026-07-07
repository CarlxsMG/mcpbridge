import { describe, test, expect, beforeEach } from "bun:test";

import { __resetDbForTesting, getDb } from "../../db/connection.js";
import {
  ADMIN_ROLES,
  isAdminRole,
  countUsers,
  countActiveAdmins,
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  touchLastLogin,
  updateUser,
  updatePassword,
  deleteUser,
} from "../user-store.js";
import { createTeam } from "../../admin/entities/teams.js";

// ---------------------------------------------------------------------------
// user-store — direct unit tests (Stryker mutation backstop for
// src/security/user-store.ts). Before P2-5 this module had NO direct test —
// only incidental coverage via bootstrap-admin/session-store — so 36 mutants
// survived once the run was scoped to src/security/__tests__ (which drops the
// incidental coverage from admin/entities/rbac.test.ts). These tests exercise
// every function + the isAdminRole guard, the ADMIN_ROLES constant, and the
// rowToUser mappings (is_active, team_id) directly.
//
// Three mutants are EQUIVALENT and left unkilled (so the effective score is
// 100%):
//  - isAdminRole L8 `typeof v === "string"` → `true`: redundant, because
//    `ADMIN_ROLES.includes(v)` already rejects every non-string (nothing
//    non-string is in the array). Verified empirically — isAdminRole(v) ===
//    ADMIN_ROLES.includes(v) for all v.
//  - updateUser L111 `result.changes > 0` → `>= 0`, and the whole condition
//    → `true`: the function early-returns on `if (!existing)`, so when it
//    reaches that line the UPDATE always matches exactly one row (changes === 1),
//    making both mutants behave identically. (updatePassword / deleteUser have
//    no such guard, so their analogous mutants ARE killed via unknown-user
//    cases that give changes === 0.)
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetDbForTesting();
});

describe("ADMIN_ROLES / isAdminRole", () => {
  test("ADMIN_ROLES lists the four roles in order (kills the L5 array + string literals)", () => {
    expect(ADMIN_ROLES).toEqual(["admin", "operator", "auditor", "viewer"]);
  });

  test("isAdminRole accepts every valid role", () => {
    for (const r of ["admin", "operator", "auditor", "viewer"]) {
      expect(isAdminRole(r)).toBe(true);
    }
  });

  test("isAdminRole rejects unknown strings (kills L8 LogicalOperator + Conditional→true)", () => {
    expect(isAdminRole("superuser")).toBe(false);
    expect(isAdminRole("")).toBe(false);
  });

  test("isAdminRole rejects non-strings (kills L8 typeof EqualityOperator + StringLiteral)", () => {
    expect(isAdminRole(123)).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole({})).toBe(false);
  });
});

describe("createUser / findUser* / countUsers / listUsers", () => {
  test("createUser inserts a row and returns the full record", () => {
    const u = createUser("alice", "hash-a", "admin", "tester");
    expect(u.id).toBeGreaterThan(0);
    expect(u.username).toBe("alice");
    expect(u.role).toBe("admin");
    expect(u.isActive).toBe(true);
    expect(u.createdBy).toBe("tester");
    expect(u.teamId).toBeNull();
  });

  test("countUsers reflects inserts", () => {
    expect(countUsers()).toBe(0);
    createUser("a", "h", "admin", null);
    createUser("b", "h", "viewer", null);
    expect(countUsers()).toBe(2);
  });

  test("findUserByUsername / findUserById return the row or null", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(findUserByUsername("alice")?.id).toBe(u.id);
    expect(findUserById(u.id)?.username).toBe("alice");
    expect(findUserByUsername("ghost")).toBeNull();
    expect(findUserById(999999)).toBeNull();
  });

  test("listUsers returns all users ordered by username (kills L76 BlockStatement)", () => {
    createUser("bob", "h", "admin", null);
    createUser("alice", "h", "viewer", null);
    const users = listUsers();
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.username)).toEqual(["alice", "bob"]);
  });
});

describe("countActiveAdmins", () => {
  test("counts only active admin-role users (kills L59 BlockStatement + the query)", () => {
    createUser("admin1", "h", "admin", null);
    createUser("op", "h", "operator", null); // not admin role → excluded
    createUser("admin2", "h", "admin", null);
    expect(countActiveAdmins()).toBe(2);

    updateUser("admin2", { isActive: false }); // inactive → excluded
    expect(countActiveAdmins()).toBe(1);
  });
});

describe("touchLastLogin", () => {
  test("sets last_login_at (kills L98 BlockStatement + L99 SQL StringLiteral)", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(findUserById(u.id)?.lastLoginAt).toBeNull();
    touchLastLogin(u.id);
    const after = findUserById(u.id)?.lastLoginAt;
    expect(after).not.toBeNull();
    expect(typeof after).toBe("number");
  });
});

describe("updateUser", () => {
  test("returns false for an unknown username (kills L105 guard)", () => {
    expect(updateUser("ghost", { role: "viewer" })).toBe(false);
  });

  test("updates role, preserves isActive, returns true (kills L111 `<=0`/Conditional→false, L107 `??`→`&&`)", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(updateUser("alice", { role: "operator" })).toBe(true);
    expect(findUserById(u.id)?.role).toBe("operator");
    // `isActive = patch.isActive ?? existing.isActive` — with no isActive in the
    // patch, the `&&` mutant yields undefined → is_active would flip to 0.
    expect(findUserById(u.id)?.isActive).toBe(true);
  });

  test("updates isActive, preserves role", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(updateUser("alice", { isActive: false })).toBe(true);
    expect(findUserById(u.id)?.isActive).toBe(false);
    expect(findUserById(u.id)?.role).toBe("admin");
  });
});

describe("updatePassword", () => {
  test("changes the hash for a known user, returns true (kills L114 block, L116 SQL, L118 `<=0`/Conditional→false)", () => {
    const u = createUser("alice", "old-hash", "admin", null);
    expect(updatePassword("alice", "new-hash")).toBe(true);
    expect(findUserById(u.id)?.passwordHash).toBe("new-hash");
  });

  test("returns false for an unknown user (kills L118 `>=0`/Conditional→true)", () => {
    expect(updatePassword("ghost", "x")).toBe(false);
  });
});

describe("deleteUser", () => {
  test("removes a known user, returns true (kills L121 block, L122 SQL, L123 `<=0`/Conditional→false)", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(deleteUser("alice")).toBe(true);
    expect(findUserById(u.id)).toBeNull();
  });

  test("returns false for an unknown user (kills L123 `>=0`/Conditional→true)", () => {
    expect(deleteUser("ghost")).toBe(false);
  });
});

describe("rowToUser mappings", () => {
  test("is_active maps to a boolean both ways", () => {
    const u = createUser("alice", "h", "admin", null);
    expect(findUserById(u.id)?.isActive).toBe(true);
    updateUser("alice", { isActive: false });
    expect(findUserById(u.id)?.isActive).toBe(false);
  });

  test("team_id maps through verbatim, not coerced (kills L49 `?? null` → `&& null`)", () => {
    const u = createUser("alice", "h", "admin", null);
    const team = createTeam("team-a", null);
    if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
    getDb().query(`UPDATE admin_users SET team_id = ? WHERE id = ?`).run(team.id, u.id);
    // `team_id ?? null` keeps the id; the `team_id && null` mutant would null it.
    expect(findUserById(u.id)?.teamId).toBe(team.id);
  });
});
