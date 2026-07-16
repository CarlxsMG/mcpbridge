/**
 * Tenancy-scoping regression tests for src/routes/usage.ts (finding #31).
 *
 * Every usage analytics query is scoped to the caller's own team the same way
 * GET /admin-api/clients is: the aggregate/by-key/top-tools/timeseries views
 * only count calls against clients the caller's team owns, and an explicit
 * `?client=` naming another team's client is rejected via `ensureClientAccess`
 * (a 404 identical to "client not found", so a scoped caller can't even probe
 * another tenant's client by name). A super-admin / bearer caller still sees
 * every team's usage. Nothing pinned this until this file — the existing usage
 * tests only ever call as the env Bearer (always a super-admin).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { recordUsage, __clearUsageForTesting } from "../../observability/usage.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-usage-tenancy";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  __clearUsageForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { usageRoutes } = await import("../../routes/usage.js");
  const app = express();
  app.use(express.json());
  usageRoutes(app);

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

function logCall(clientName: string): void {
  recordUsage({ clientName, toolName: "t", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
}

function teamSessionHeaders(
  username: string,
  role: "admin" | "operator" | "viewer" = "viewer",
): {
  headers: Record<string, string>;
  teamId: number;
} {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", role, null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    teamId: team.id,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
      "X-CSRF-Token": session.csrfToken,
    },
  };
}

/** Registers svc-a (owned by the caller's team) + svc-b (another team), logs 2 + 3 calls. */
async function seedTwoTeams(): Promise<{ headers: Record<string, string> }> {
  await reg("svc-a");
  await reg("svc-b");
  const { headers, teamId } = teamSessionHeaders("usage-team-user");
  const otherTeam = createTeam("usage-other-team", "test");
  if (typeof otherTeam === "string") throw new Error("createTeam failed");
  setClientTeam("svc-a", teamId);
  setClientTeam("svc-b", otherTeam.id);

  logCall("svc-a");
  logCall("svc-a");
  logCall("svc-b");
  logCall("svc-b");
  logCall("svc-b");
  return { headers };
}

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __clearUsageForTesting();
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("usage analytics — team scoping", () => {
  test("/usage/summary counts only the caller's team's clients", async () => {
    await startApp();
    const { headers } = await seedTwoTeams();

    const scoped = await fetch(`${baseUrl}/admin-api/usage/summary`, { headers });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { calls: number };
    expect(scopedBody.calls).toBe(2);

    const all = await fetch(`${baseUrl}/admin-api/usage/summary`, { headers: bearer() });
    const allBody = (await all.json()) as { calls: number };
    expect(allBody.calls).toBe(5);
  });

  test("/usage/timeseries totals only the caller's team's calls", async () => {
    await startApp();
    const { headers } = await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/usage/timeseries`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points: { calls: number }[] };
    const total = body.points.reduce((sum, p) => sum + p.calls, 0);
    expect(total).toBe(2);
  });

  test("/usage/top-tools excludes another team's tools", async () => {
    await startApp();
    const { headers } = await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/usage/top-tools`, { headers });
    const body = (await res.json()) as { items: { client: string; calls: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.client).toBe("svc-a");
    expect(body.items[0]?.calls).toBe(2);
  });

  test("/usage/by-key totals only the caller's team's calls", async () => {
    await startApp();
    const { headers } = await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/usage/by-key`, { headers });
    const body = (await res.json()) as { items: { calls: number }[] };
    const total = body.items.reduce((sum, r) => sum + r.calls, 0);
    expect(total).toBe(2);
  });

  test("an explicit ?client= naming another team's client is rejected (404, not a probe)", async () => {
    await startApp();
    const { headers } = await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/usage/summary?client=svc-b`, { headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");
  });

  test("a super-admin (bearer) CAN scope to any client by name", async () => {
    await startApp();
    await seedTwoTeams();

    const res = await fetch(`${baseUrl}/admin-api/usage/summary?client=svc-b`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calls: number };
    expect(body.calls).toBe(3);
  });
});
