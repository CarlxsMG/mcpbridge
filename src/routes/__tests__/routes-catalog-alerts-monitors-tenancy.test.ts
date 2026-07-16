/**
 * Tenancy + role regression tests for the three shared/global admin surfaces
 * that carry no team_id of their own (finding #33):
 *
 *  - alert_rules (src/routes/alerts.ts): read is operator+; every mutation
 *    (create/patch/delete/test) requires a super-admin, since a rule evaluates
 *    gateway-wide state across every tenant and a team-scoped admin must not be
 *    able to plant/retarget/silence platform-wide alerting.
 *  - catalog_entries (src/routes/catalog.ts): a single shared marketplace —
 *    read is open to any authenticated admin, but create/edit/delete require a
 *    super-admin.
 *  - synthetic monitors (src/routes/admin/monitors.ts): tool_monitor has no
 *    team_id, but each row's client_name maps to a team via `clients`, so a
 *    team-scoped caller only sees monitors on clients their team owns.
 *
 * Existing tests for these files only ever call as the env Bearer (a
 * super-admin), so nothing pinned the team-scoped-admin rejection / monitor
 * scoping until this file.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { registry } from "../../mcp/registry.js";
import { setMonitor } from "../../observability/monitor.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam, setClientTeam } from "../../admin/entities/teams.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-cam-tenancy";
const originalAllowPrivate = config.allowPrivateIps;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { alertRoutes } = await import("../../routes/alerts.js");
  const { catalogRoutes } = await import("../../routes/catalog.js");
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  alertRoutes(app);
  catalogRoutes(app);
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
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
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

/** A session for a user with the given role, optionally bound to a team. */
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

/** A session for an admin-role user scoped to a fresh team (i.e. NOT a super-admin). */
function teamAdminHeaders(username: string): Record<string, string> {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  return sessionHeaders(username, "admin", team.id);
}

const VALID_ALERT = { name: "cb", eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/x" };

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("alert rules — read is operator+, mutate is super-admin only", () => {
  test("an operator can read, a viewer cannot", async () => {
    await startApp();

    const asOperator = await fetch(`${baseUrl}/admin-api/alerts`, {
      headers: sessionHeaders("alert-op", "operator", null),
    });
    expect(asOperator.status).toBe(200);

    const asViewer = await fetch(`${baseUrl}/admin-api/alerts`, {
      headers: sessionHeaders("alert-viewer", "viewer", null),
    });
    expect(asViewer.status).toBe(403);
  });

  test("a team-scoped admin cannot create an alert rule (super-admin only)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts`, {
      method: "POST",
      headers: teamAdminHeaders("alert-team-admin"),
      body: JSON.stringify(VALID_ALERT),
    });
    expect(res.status).toBe(403);
  });

  test("a viewer cannot create an alert rule", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts`, {
      method: "POST",
      headers: sessionHeaders("alert-viewer-mutate", "viewer", null),
      body: JSON.stringify(VALID_ALERT),
    });
    expect(res.status).toBe(403);
  });

  test("a super-admin (bearer) can create an alert rule", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify(VALID_ALERT),
    });
    expect(res.status).toBe(201);
  });
});

describe("catalog entries — read open, mutate is super-admin only", () => {
  test("a team-scoped admin can read the catalog but cannot create an entry", async () => {
    await startApp();
    const headers = teamAdminHeaders("catalog-team-admin");

    const read = await fetch(`${baseUrl}/admin-api/catalog`, { headers });
    expect(read.status).toBe(200);

    const create = await fetch(`${baseUrl}/admin-api/catalog`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "svc-x", name: "Svc X", kind: "rest" }),
    });
    expect(create.status).toBe(403);
  });

  test("a super-admin can create a catalog entry, and a team-scoped admin cannot edit it", async () => {
    await startApp();
    const created = await fetch(`${baseUrl}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "svc-y", name: "Svc Y", kind: "rest" }),
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { id: string };

    const edit = await fetch(`${baseUrl}/admin-api/catalog/${encodeURIComponent(entry.id)}`, {
      method: "PATCH",
      headers: teamAdminHeaders("catalog-team-editor"),
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(edit.status).toBe(403);
  });
});

describe("synthetic monitors — team scoping", () => {
  test("a team-scoped caller only sees monitors on its own team's clients", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");
    const teamA = createTeam("monitors-team-a", "test");
    if (typeof teamA === "string") throw new Error("createTeam failed");
    const teamB = createTeam("monitors-team-b", "test");
    if (typeof teamB === "string") throw new Error("createTeam failed");
    setClientTeam("svc-a", teamA.id);
    setClientTeam("svc-b", teamB.id);

    expect(await setMonitor("svc-a", "t", { exampleId: 1, intervalMinutes: 5, enabled: true })).toEqual({ ok: true });
    expect(await setMonitor("svc-b", "t", { exampleId: 1, intervalMinutes: 5, enabled: true })).toEqual({ ok: true });

    const scoped = await fetch(`${baseUrl}/admin-api/monitors`, {
      headers: sessionHeaders("monitors-team-user", "admin", teamA.id),
    });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { items: { clientName: string }[] };
    expect(scopedBody.items.map((m) => m.clientName)).toEqual(["svc-a"]);

    const all = await fetch(`${baseUrl}/admin-api/monitors`, { headers: bearer() });
    const allBody = (await all.json()) as { items: { clientName: string }[] };
    expect(allBody.items.map((m) => m.clientName).sort()).toEqual(["svc-a", "svc-b"]);
  });
});
