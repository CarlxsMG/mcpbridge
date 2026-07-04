/**
 * Granular RBAC: operator/auditor/viewer capability gating + audit export.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { createUser, type AdminRole } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../security/cookies.js";
import type { RestToolDefinition } from "../mcp/types.js";

let baseUrl = "";
let server: Server | null = null;

function makeTool(): RestToolDefinition {
  return {
    name: "t",
    method: "GET",
    endpoint: "/t",
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app);
  await new Promise<void>((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
    });
  });
}

function sessionHeaders(role: AdminRole, username: string): Record<string, string> {
  const u = createUser(username, "hash", role, null);
  const s = createSession(u.id, "127.0.0.1", "agent");
  return {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${s.token}; ${CSRF_COOKIE_NAME}=${s.csrfToken}`,
    "X-CSRF-Token": s.csrfToken,
  };
}

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("granular RBAC", () => {
  test("operator can operate a client but cannot manage users", async () => {
    await startApp();
    await reg("svc");
    const op = sessionHeaders("operator", "op");
    const toggle = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: op,
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);
    const createUserRes = await fetch(`${baseUrl}/admin-api/users`, {
      method: "POST",
      headers: op,
      body: JSON.stringify({ username: "x", password: "correct-horse-battery-staple" }),
    });
    expect(createUserRes.status).toBe(403);
  });

  test("auditor is read-only", async () => {
    await startApp();
    await reg("svc");
    const aud = sessionHeaders("auditor", "aud");
    const read = await fetch(`${baseUrl}/admin-api/clients`, { headers: { Cookie: aud.Cookie } });
    expect(read.status).toBe(200);
    const toggle = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: aud,
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(403);
  });

  test("viewer cannot operate", async () => {
    await startApp();
    await reg("svc");
    const v = sessionHeaders("viewer", "v");
    const toggle = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: v,
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(403);
  });

  test("admin can create a user with the operator role", async () => {
    await startApp();
    const admin = sessionHeaders("admin", "root");
    const res = await fetch(`${baseUrl}/admin-api/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ username: "newop", password: "correct-horse-battery-staple", role: "operator" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { role: string }).role).toBe("operator");
  });

  test("audit-log export returns recorded entries", async () => {
    await startApp();
    await reg("svc");
    const admin = sessionHeaders("admin", "root");
    await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ enabled: false }),
    });
    const exp = await fetch(`${baseUrl}/admin-api/audit-log/export`, { headers: { Cookie: admin.Cookie } });
    expect(exp.status).toBe(200);
    const body = (await exp.json()) as { items: unknown[]; count: number };
    expect(body.count).toBeGreaterThan(0);
  });
});
