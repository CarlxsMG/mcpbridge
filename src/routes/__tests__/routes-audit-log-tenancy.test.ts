/**
 * Tenancy + role regression tests for src/routes/admin/audit-log.ts
 * (finding #32).
 *
 * GET /audit-log and /audit-log/export require operator+ (a captured record's
 * detail_json can carry the same sensitive payload data traffic records do, so
 * viewer/auditor tiers must not read it), and both additionally scope to the
 * caller's team: a team-bound caller only sees rows whose `target` is one of
 * their team's client names (or a `clientName__toolName` composite owned by
 * one). A super-admin / bearer caller sees every team's entries. Nothing
 * pinned this until this file — existing audit tests only call as the env
 * Bearer (always a super-admin).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { recordAudit } from "../../admin/audit/audit.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-audit-tenancy";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  adminRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      activeServer = srv;
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

async function reg(name: string): Promise<void> {
  await registry.register(
    name,
    [{ name: "t", method: "GET", endpoint: "/t", description: "d", inputSchema: { type: "object", properties: {} } }],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

function sessionHeaders(
  username: string,
  role: "admin" | "operator" | "viewer",
  teamId: number | null,
): Record<string, string> {
  const user = createUser(username, "irrelevant-hash", role, null);
  if (teamId !== null) setUserTeam(user.username, teamId);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "X-CSRF-Token": session.csrfToken,
  };
}

/** Registers svc-a (caller's team) + svc-b (another team); records one audit row targeting each. */
async function seedTwoTeams(): Promise<{ teamId: number }> {
  await reg("svc-a");
  await reg("svc-b");
  const team = createTeam("audit-team-a", "test");
  if (typeof team === "string") throw new Error("createTeam failed");
  const otherTeam = createTeam("audit-team-b", "test");
  if (typeof otherTeam === "string") throw new Error("createTeam failed");
  setClientTeam("svc-a", team.id);
  setClientTeam("svc-b", otherTeam.id);

  recordAudit("actor-a", "client.enable", "svc-a");
  recordAudit("actor-b", "client.enable", "svc-b");
  return { teamId: team.id };
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/audit-log — team scoping + role", () => {
  test("a team-scoped operator sees only its own team's entries", async () => {
    await startApp();
    const { teamId } = await seedTwoTeams();
    const headers = sessionHeaders("audit-op", "operator", teamId);

    const res = await fetch(`${baseUrl}/admin-api/audit-log`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { target: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.target === "svc-a" || i.target.startsWith("svc-a__"))).toBe(true);
    expect(body.items.some((i) => i.target === "svc-b")).toBe(false);
  });

  test("a super-admin (bearer) sees every team's entries", async () => {
    await startApp();
    await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const body = (await res.json()) as { items: { target: string }[] };
    const targets = body.items.map((i) => i.target);
    expect(targets).toContain("svc-a");
    expect(targets).toContain("svc-b");
  });

  test("a viewer is rejected (operator required)", async () => {
    await startApp();
    await seedTwoTeams();
    const headers = sessionHeaders("audit-viewer", "viewer", null);

    const res = await fetch(`${baseUrl}/admin-api/audit-log`, { headers });
    expect(res.status).toBe(403);
  });
});

describe("GET /admin-api/audit-log/export — team scoping + role", () => {
  test("a team-scoped operator's export contains only its own team's entries", async () => {
    await startApp();
    const { teamId } = await seedTwoTeams();
    const headers = sessionHeaders("audit-export-op", "operator", teamId);

    const res = await fetch(`${baseUrl}/admin-api/audit-log/export?format=json`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { target: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.target === "svc-a" || i.target.startsWith("svc-a__"))).toBe(true);
    expect(body.items.some((i) => i.target === "svc-b")).toBe(false);
  });

  test("a viewer is rejected from export (operator required)", async () => {
    await startApp();
    await seedTwoTeams();
    const headers = sessionHeaders("audit-export-viewer", "viewer", null);

    const res = await fetch(`${baseUrl}/admin-api/audit-log/export?format=json`, { headers });
    expect(res.status).toBe(403);
  });
});
