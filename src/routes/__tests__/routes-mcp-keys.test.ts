/**
 * HTTP-level tests for src/routes/mcp-keys.ts — mirrors the routes-admin.test.ts
 * harness (real express() + native fetch, Bearer admin auth, in-memory DB).
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import { createTeam, setUserTeam } from "../../admin/entities/teams.js";

/** Creates an admin-role session scoped to a real team (not a super-admin) — for adminRole-grant gating tests. */
function teamAdminSessionHeaders(username: string): Record<string, string> {
  const team = createTeam(`team-${username}`, "test");
  if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
  const user = createUser(username, "irrelevant-hash", "admin", null);
  setUserTeam(user.username, team.id);
  const session = createSession(user.id, "127.0.0.1", "test-agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
    "X-CSRF-Token": session.csrfToken,
  };
}

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { mcpKeyRoutes } = await import("../../routes/mcp-keys.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  mcpKeyRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

afterEach(async () => {
  await stopServer();
});

describe("POST /admin-api/mcp-keys", () => {
  test("mints a key and returns the raw secret exactly once", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "ci-bot", scopes: { clients: ["svc"] } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; key: string; keyPrefix: string; scopes: unknown };
    expect(body.key.startsWith("mcp_")).toBe(true);
    expect(body.keyPrefix).toBe(body.key.slice(0, 12));
    expect(body.scopes).toEqual({ clients: ["svc"] });

    // A subsequent GET must not expose the raw key again.
    const getRes = await fetch(`${baseUrl}/admin-api/mcp-keys/${body.id}`, { headers: bearer() });
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(JSON.stringify(got)).not.toContain(body.key);
    expect(got.key).toBeUndefined();
  });

  test("400 when label is missing", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ scopes: { clients: ["svc"] } }),
    });
    expect(res.status).toBe(400);
  });

  test("400 for a malformed scopes object", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", scopes: { clients: [123] } }),
    });
    expect(res.status).toBe(400);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "k" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET/PATCH/revoke/DELETE /admin-api/mcp-keys", () => {
  async function mint(label = "k"): Promise<{ id: number }> {
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label }),
    });
    return (await res.json()) as { id: number };
  }

  test("lists minted keys", async () => {
    await startApp();
    await mint("a");
    await mint("b");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, { headers: bearer() });
    const body = (await res.json()) as { items: { label: string }[] };
    expect(body.items.map((k) => k.label).sort()).toEqual(["a", "b"]);
  });

  test("patches label and enabled", async () => {
    await startApp();
    const { id } = await mint("orig");
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ label: "renamed", enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string; enabled: boolean };
    expect(body.label).toBe("renamed");
    expect(body.enabled).toBe(false);
  });

  test("revoke then revoke-again returns 409", async () => {
    await startApp();
    const { id } = await mint();
    const first = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}/revoke`, { method: "POST", headers: bearer() });
    expect(second.status).toBe(409);
  });

  test("delete then 404", async () => {
    await startApp();
    const { id } = await mint();
    const del = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
    const again = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, { method: "DELETE", headers: bearer() });
    expect(again.status).toBe(404);
  });

  test("404 for unknown id", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/424242`, { headers: bearer() });
    expect(res.status).toBe(404);
  });
});

describe("Role gating", () => {
  test("a viewer session cannot mint a key (403)", async () => {
    await startApp();
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({ label: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("adminRole — /mcp system control-plane grants", () => {
  test("the env Bearer (always a super-admin) can mint a key with adminRole set", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "ops-bot", adminRole: "operator" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { adminRole: string | null };
    expect(body.adminRole).toBe("operator");
  });

  test("400 for an invalid adminRole value", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "k", adminRole: "superuser" }),
    });
    expect(res.status).toBe(400);
  });

  test("a team-scoped admin can grant neither adminRole nor an unscoped/foreign-scoped key", async () => {
    await startApp();
    const headers = teamAdminSessionHeaders("team-admin");

    // Control-plane role: super-admin only.
    const withRole = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "escalate", adminRole: "admin" }),
    });
    expect(withRole.status).toBe(403);

    // Unscoped key: reaches every tenant's clients via /mcp/:clientName, so a
    // team-scoped admin must confine it to its own team's clients — an unscoped
    // mint is rejected.
    const unscoped = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "plain" }),
    });
    expect(unscoped.status).toBe(403);

    // A key scoped to a client the team doesn't own is rejected the same way.
    const foreign = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "foreign", scopes: { clients: ["someone-elses-client"] } }),
    });
    expect(foreign.status).toBe(403);
  });

  test("PATCH also requires a super-admin to set adminRole", async () => {
    await startApp();
    const { id } = await mintViaFetch();
    const headers = teamAdminSessionHeaders("team-admin-2");

    const res = await fetch(`${baseUrl}/admin-api/mcp-keys/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ adminRole: "admin" }),
    });
    expect(res.status).toBe(403);
  });

  async function mintViaFetch(): Promise<{ id: number }> {
    const res = await fetch(`${baseUrl}/admin-api/mcp-keys`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "target" }),
    });
    return (await res.json()) as { id: number };
  }
});
