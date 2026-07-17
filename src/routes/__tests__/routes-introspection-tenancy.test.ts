/**
 * Tenant-isolation regression for the top-level introspection routes
 * (GET /clients, GET /clients/:name/tools). These legacy routes previously
 * called registry.listClients()/getClientTools() with NO team filter, so a
 * team-scoped session could enumerate every other tenant's backends (name,
 * internal resolved IP, health_url) and dump their tool schemas — the exact
 * cross-tenant-read break the rest of the admin surface forbids. The sibling
 * DELETE already scoped via ensureClientAccess; these GETs were missed.
 *
 * Asserts the DENIED half: a team-B session cannot see or read team-A's client.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const ADMIN_KEY = "test-admin-key-introspection-tenancy";
let server: Server | null = null;

async function startApp(): Promise<string> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { introspectionRoutes } = await import("../../routes/introspection.js");
  const app = express();
  app.use(express.json());
  introspectionRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      server = srv;
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
    srv.on("error", reject);
  });
}

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await new Promise<void>((resolve) => {
    if (server) server.close(() => ((server = null), resolve()));
    else resolve();
  });
});

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

/** A session for an admin-role user scoped to a real team (not a super-admin). Returns headers + the team id. */
function teamAdminSession(username: string): { headers: Record<string, string>; teamId: number } {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    teamId: team.id,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
  };
}

async function regForTeam(name: string, teamId: number): Promise<void> {
  const tools: RestToolDefinition[] = [
    { name: "t1", method: "GET", endpoint: "/t1", description: "t1", inputSchema: { type: "object", properties: {} } },
  ];
  await registry.register(
    name,
    tools,
    "http://team-a-internal.example/health",
    "10.1.2.3",
    "http://team-a-internal.example",
    "10.1.2.3",
  );
  expect(setClientTeam(name, teamId)).toBe(true);
}

describe("introspection routes — team tenancy", () => {
  test("GET /clients hides another team's client from a team-scoped session", async () => {
    const baseUrl = await startApp();
    const teamA = teamAdminSession("iso-a");
    const teamB = teamAdminSession("iso-b");
    await regForTeam("svc-team-a", teamA.teamId);

    const asB = await fetch(`${baseUrl}/clients`, { headers: teamB.headers });
    expect(asB.status).toBe(200);
    const bodyB = (await asB.json()) as { clients: Array<{ name: string }> };
    expect(bodyB.clients.map((c) => c.name)).not.toContain("svc-team-a");

    // Owner and super-admin still see it.
    const asA = await fetch(`${baseUrl}/clients`, { headers: teamA.headers });
    expect(((await asA.json()) as { clients: Array<{ name: string }> }).clients.map((c) => c.name)).toContain(
      "svc-team-a",
    );
    const asBearer = await fetch(`${baseUrl}/clients`, { headers: bearer() });
    expect(((await asBearer.json()) as { clients: Array<{ name: string }> }).clients.map((c) => c.name)).toContain(
      "svc-team-a",
    );
  });

  test("GET /clients/:name/tools returns 404 (not the schema) for another team's client", async () => {
    const baseUrl = await startApp();
    const teamA = teamAdminSession("iso-tools-a");
    const teamB = teamAdminSession("iso-tools-b");
    await regForTeam("svc-secret", teamA.teamId);

    const asB = await fetch(`${baseUrl}/clients/svc-secret/tools`, { headers: teamB.headers });
    expect(asB.status).toBe(404);
    const body = (await asB.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");

    // Owner can read its own tools.
    const asA = await fetch(`${baseUrl}/clients/svc-secret/tools`, { headers: teamA.headers });
    expect(asA.status).toBe(200);
  });
});
