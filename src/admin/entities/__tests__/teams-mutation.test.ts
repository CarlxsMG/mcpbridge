/**
 * Stryker mutation-testing backstop for src/admin/entities/teams.ts.
 *
 * The sibling hand-written teams.test.ts already covers: createTeam's
 * name-validation + already-exists branches, valid client/user assignment,
 * the canAccessClient decision matrix (all 5 branches), FK-cascade unassignment
 * of a client on team delete, and end-to-end route enforcement. This file
 * gap-fills what that one doesn't touch directly on the module:
 *   - getTeam (entirely untested at baseline: found/not-found + exact field shape)
 *   - rowTo()'s field mapping, verified with distinct, type-distinguishable values
 *     (not just `typeof t === "object"`)
 *   - listTeams() with >= 2 distinctly-named teams (ordering / narrowing)
 *   - deleteTeam(unknown id) -> false (boundary opposite of the existing true case)
 *   - setClientTeam / setUserTeam: the "clear" (teamId=null) path, and the
 *     "unknown but non-null teamId" path -- neither is exercised by the
 *     existing file, and both are needed to kill the !==/=== and &&/||
 *     mutants on the `teamId !== null && !teamExists` guard
 *   - getClientTeam on an unassigned (but real) client -> null, vs an unknown
 *     client -> undefined (three-way ternary, only the "assigned" case is
 *     covered upstream)
 *   - FK ON DELETE SET NULL for admin_users.team_id (only the clients-side
 *     cascade is covered upstream)
 *   - ADMIN_ENTITY_NAME_RE length boundaries (1 char, 63 chars, 64 chars)
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import {
  listTeams,
  getTeam,
  createTeam,
  deleteTeam,
  getClientTeam,
  setClientTeam,
  setUserTeam,
  type Team,
} from "../../../admin/entities/teams.js";
import { createUser } from "../../../security/user-store.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(() => {
  __resetDbForTesting();
});

describe("getTeam", () => {
  test("unknown id -> null", () => {
    expect(getTeam(999999)).toBeNull();
  });

  test("known id -> exact field shape, distinguishable per-field", () => {
    const before = Date.now();
    const created = createTeam("Field Shape Co", "creator-actor") as Team;
    const after = Date.now();

    const fetched = getTeam(created.id);
    expect(fetched).not.toBeNull();
    const t = fetched as Team;
    expect(t.id).toBe(created.id);
    expect(typeof t.id).toBe("number");
    expect(t.name).toBe("Field Shape Co");
    expect(typeof t.createdAt).toBe("number");
    expect(t.createdAt).toBeGreaterThanOrEqual(before);
    expect(t.createdAt).toBeLessThanOrEqual(after);
    expect(t.createdBy).toBe("creator-actor");
  });

  test("null actor -> createdBy is null (not the string 'null')", () => {
    const created = createTeam("No Actor Team", null) as Team;
    expect(created.createdBy).toBeNull();
    expect(getTeam(created.id)?.createdBy).toBeNull();
  });
});

describe("createTeam — name length boundaries", () => {
  test("1-character name is valid (minimum)", () => {
    const r = createTeam("a", null);
    expect(typeof r).toBe("object");
    expect((r as Team).name).toBe("a");
  });

  test("63-character name is valid (maximum)", () => {
    const name = "a" + "b".repeat(62);
    expect(name.length).toBe(63);
    const r = createTeam(name, null);
    expect(typeof r).toBe("object");
    expect((r as Team).name).toBe(name);
  });

  test("64-character name is invalid (over maximum)", () => {
    const name = "a" + "b".repeat(63);
    expect(name.length).toBe(64);
    expect(createTeam(name, null)).toBe("INVALID_NAME");
  });
});

describe("listTeams", () => {
  test("empty when no teams exist", () => {
    expect(listTeams()).toEqual([]);
  });

  test(">= 2 distinctly-named teams: all present, ordered by name", () => {
    createTeam("Zebra Team", null);
    createTeam("Alpha Team", null);
    createTeam("Mango Team", null);
    const names = listTeams().map((t) => t.name);
    expect(names).toEqual(["Alpha Team", "Mango Team", "Zebra Team"]);
    expect(names).toHaveLength(3);
  });
});

describe("deleteTeam", () => {
  test("unknown id -> false, and does not disturb other rows", () => {
    const t = createTeam("Survivor", null) as Team;
    expect(deleteTeam(999999)).toBe(false);
    expect(listTeams()).toHaveLength(1);
    expect(getTeam(t.id)).not.toBeNull();
  });

  test("known id -> true, and it's actually gone", () => {
    const t = createTeam("Ephemeral", null) as Team;
    expect(deleteTeam(t.id)).toBe(true);
    expect(getTeam(t.id)).toBeNull();
    expect(listTeams()).toEqual([]);
  });
});

describe("getClientTeam", () => {
  test("unknown client -> undefined", () => {
    expect(getClientTeam("no-such-client")).toBeUndefined();
  });

  test("known client, never assigned -> null (not undefined)", async () => {
    await reg("fresh-client");
    const v = getClientTeam("fresh-client");
    expect(v).toBeNull();
    expect(v).not.toBeUndefined();
  });
});

describe("setClientTeam — clear + invalid-team-id paths", () => {
  test("unknown (non-null) teamId on a real client -> false, leaves client unowned", async () => {
    await reg("svc-a");
    expect(setClientTeam("svc-a", 424242)).toBe(false);
    expect(getClientTeam("svc-a")).toBeNull();
  });

  test("assign then clear (teamId: null) -> true, and it actually reads back null", async () => {
    await reg("svc-b");
    const t = createTeam("Owner Team", null) as Team;
    expect(setClientTeam("svc-b", t.id)).toBe(true);
    expect(getClientTeam("svc-b")).toBe(t.id);

    expect(setClientTeam("svc-b", null)).toBe(true);
    expect(getClientTeam("svc-b")).toBeNull();
  });
});

describe("setUserTeam — clear + invalid-team-id paths", () => {
  test("unknown (non-null) teamId on a real user -> false, leaves user unowned", () => {
    createUser("plain-user", "x", "admin", null);
    expect(setUserTeam("plain-user", 424242)).toBe(false);
    const row = getDb().query(`SELECT team_id FROM admin_users WHERE username = ?`).get("plain-user") as {
      team_id: number | null;
    };
    expect(row.team_id).toBeNull();
  });

  test("assign then clear (teamId: null) -> true, and it actually reads back null", () => {
    createUser("team-user", "x", "admin", null);
    const t = createTeam("User Owner Team", null) as Team;
    expect(setUserTeam("team-user", t.id)).toBe(true);
    let row = getDb().query(`SELECT team_id FROM admin_users WHERE username = ?`).get("team-user") as {
      team_id: number | null;
    };
    expect(row.team_id).toBe(t.id);

    expect(setUserTeam("team-user", null)).toBe(true);
    row = getDb().query(`SELECT team_id FROM admin_users WHERE username = ?`).get("team-user") as {
      team_id: number | null;
    };
    expect(row.team_id).toBeNull();
  });

  test("unknown username -> false, no row created", () => {
    const t = createTeam("Ghost Owner", null) as Team;
    expect(setUserTeam("ghost-user", t.id)).toBe(false);
    const row = getDb().query(`SELECT 1 FROM admin_users WHERE username = ?`).get("ghost-user");
    expect(row).toBeNull();
  });
});

describe("deleting a team unassigns its users too (FK ON DELETE SET NULL)", () => {
  test("admin_users.team_id is nulled out when the owning team is deleted", () => {
    createUser("cascade-user", "x", "admin", null);
    const t = createTeam("Cascading Team", null) as Team;
    expect(setUserTeam("cascade-user", t.id)).toBe(true);

    expect(deleteTeam(t.id)).toBe(true);

    const row = getDb().query(`SELECT team_id FROM admin_users WHERE username = ?`).get("cascade-user") as {
      team_id: number | null;
    };
    expect(row.team_id).toBeNull();
  });
});
