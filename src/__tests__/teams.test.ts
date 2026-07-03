/**
 * Team multi-tenancy — the teams module, registry team-scoped listing, and
 * end-to-end route enforcement via real team-scoped sessions.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import {
  createTeam,
  deleteTeam,
  listTeams,
  setClientTeam,
  getClientTeam,
  setUserTeam,
  canAccessClient,
} from "../teams.js";
import { createUser } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import type { RestToolDefinition } from "../types.js";

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

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("teams — module", () => {
  test("create / list / delete + name validation", () => {
    const t = createTeam("Team Alpha", "admin");
    expect(typeof t).toBe("object");
    expect(createTeam("Team Alpha", "admin")).toBe("ALREADY_EXISTS");
    expect(createTeam("bad/name", "admin")).toBe("INVALID_NAME");
    expect(listTeams()).toHaveLength(1);
    expect(deleteTeam((t as { id: number }).id)).toBe(true);
  });

  test("client + user ownership assignment", async () => {
    await reg("svc");
    const t = createTeam("t1", null) as { id: number };
    expect(setClientTeam("svc", t.id)).toBe(true);
    expect(getClientTeam("svc")).toBe(t.id);
    expect(setClientTeam("ghost", t.id)).toBe(false);
    createUser("u1", "x", "admin", null);
    expect(setUserTeam("u1", t.id)).toBe(true);
    expect(setUserTeam("nobody", t.id)).toBe(false);
  });

  test("canAccessClient decision matrix", () => {
    expect(canAccessClient(undefined, 5)).toBe(true); // bearer
    expect(canAccessClient(null, 5)).toBe(true); // super-admin
    expect(canAccessClient(5, 5)).toBe(true);
    expect(canAccessClient(5, 6)).toBe(false);
    expect(canAccessClient(5, null)).toBe(false); // team user can't see unowned
  });

  test("deleting a team unassigns its clients (FK SET NULL)", async () => {
    await reg("svc");
    const t = createTeam("t1", null) as { id: number };
    setClientTeam("svc", t.id);
    deleteTeam(t.id);
    expect(getClientTeam("svc")).toBeNull();
  });
});

describe("registry — team-scoped listing", () => {
  test("a teamId filter returns only that team's clients", async () => {
    await reg("a");
    await reg("b");
    const t = createTeam("t1", null) as { id: number };
    setClientTeam("a", t.id);
    expect(registry.listClientsSummary({ teamId: t.id }).items.map((i) => i.name)).toEqual(["a"]);
    expect(
      registry
        .listClientsSummary({})
        .items.map((i) => i.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("teams — route enforcement", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;
  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { adminRoutes } = await import("../routes/admin.js");
    const { teamRoutes } = await import("../routes/teams.js");
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    adminRoutes(app);
    teamRoutes(app);
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        server = srv;
        resolve();
      });
    });
  }
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });
  function sessionCookie(username: string, teamId: number): string {
    const u = createUser(username, "x", "admin", null);
    setUserTeam(username, teamId);
    const s = createSession(u.id, "127.0.0.1", "test");
    return `${SESSION_COOKIE_NAME}=${s.token}`;
  }

  test("a team user sees only its own team's client; another team gets 404", async () => {
    await reg("owned");
    const t1 = createTeam("t1", null) as { id: number };
    const t2 = createTeam("t2", null) as { id: number };
    setClientTeam("owned", t1.id);
    await startApp();

    const u1 = sessionCookie("u1", t1.id);
    const u2 = sessionCookie("u2", t2.id);

    const ok = await fetch(`${baseUrl}/admin-api/clients/owned`, { headers: { Cookie: u1 } });
    expect(ok.status).toBe(200);

    const denied = await fetch(`${baseUrl}/admin-api/clients/owned`, { headers: { Cookie: u2 } });
    expect(denied.status).toBe(404);

    const list1 = (await (await fetch(`${baseUrl}/admin-api/clients`, { headers: { Cookie: u1 } })).json()) as {
      items: { name: string }[];
    };
    expect(list1.items.map((i) => i.name)).toContain("owned");
    const list2 = (await (await fetch(`${baseUrl}/admin-api/clients`, { headers: { Cookie: u2 } })).json()) as {
      items: { name: string }[];
    };
    expect(list2.items.map((i) => i.name)).not.toContain("owned");
  });

  test("super-admin (bearer) manages teams and assigns ownership", async () => {
    await reg("owned");
    await startApp();
    const bearer = { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };

    const create = await fetch(`${baseUrl}/admin-api/teams`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Payments" }),
    });
    expect(create.status).toBe(201);
    const team = (await create.json()) as { id: number };

    const assign = await fetch(`${baseUrl}/admin-api/clients/owned/team`, {
      method: "PUT",
      headers: bearer,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(assign.status).toBe(200);

    const detail = (await (await fetch(`${baseUrl}/admin-api/clients/owned`, { headers: bearer })).json()) as {
      teamId: number | null;
    };
    expect(detail.teamId).toBe(team.id);
  });

  test("a team-scoped admin cannot manage teams (super-admin only)", async () => {
    const t1 = createTeam("t1", null) as { id: number };
    await startApp();
    const scoped = sessionCookie("scoped", t1.id);
    const res = await fetch(`${baseUrl}/admin-api/teams`, {
      method: "POST",
      headers: { Cookie: scoped, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(403);
  });
});
