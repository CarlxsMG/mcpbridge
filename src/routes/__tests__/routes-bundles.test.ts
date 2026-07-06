/**
 * HTTP-level tests for src/routes/bundles.ts — real express() instance + native
 * fetch(), matching routes-admin.test.ts's conventions. Both bundleRoutes and
 * adminRoutes are mounted (same as production index.ts) so audit entries can
 * be verified via the existing /admin-api/audit-log endpoint.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { initBundles } from "../../admin/tool-composition/bundles.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  initBundles();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { adminRoutes } = await import("../../routes/admin.js");
  const { bundleRoutes } = await import("../../routes/bundles.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  adminRoutes(app);
  bundleRoutes(app);

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

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopServer();
});

describe("GET /admin-api/bundles", () => {
  test("lists bundles with tool counts", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);
    await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [{ client: "svc", tool: "t1" }] }),
    });

    const res = await fetch(`${baseUrl}/admin-api/bundles`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { name: string; description: string | null; enabled: boolean; toolsCount: number }[];
    };
    expect(body.items).toEqual([{ name: "b", description: null, enabled: true, toolsCount: 1 }]);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles`);
    expect(res.status).toBe(401);
  });
});

describe("GET /admin-api/bundles/:name", () => {
  test("404 for an unknown bundle", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, { headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
  });
});

describe("POST /admin-api/bundles", () => {
  test("creates a bundle and returns its detail, and records an audit entry", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "t1" })]);

    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", description: "desc", tools: [{ client: "svc", tool: "t1" }] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; tools: { client: string; tool: string }[] };
    expect(body.name).toBe("b");
    expect(body.tools).toEqual([{ client: "svc", tool: "t1" }]);

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(audit.items.some((e) => e.action === "bundle.create" && e.target === "b")).toBe(true);
  });

  test("rejects an invalid name", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "Not Valid!", tools: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("409 when creating a duplicate bundle name", async () => {
    await startApp();
    await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [] }),
    });

    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [] }),
    });
    expect(res.status).toBe(409);
  });

  test("400 for a tool pair that doesn't exist", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [{ client: "nope", tool: "nope" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNKNOWN_TOOL");
  });

  test("400 when tools[] exceeds the max-tools cap", async () => {
    await startApp();
    (config as Record<string, unknown>).maxToolsPerClient = 2;
    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "b",
        tools: [
          { client: "a", tool: "x" },
          { client: "a", tool: "y" },
          { client: "a", tool: "z" },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /admin-api/bundles/:name", () => {
  test("toggles enabled and records an audit entry", async () => {
    await startApp();
    await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [] }),
    });

    const res = await fetch(`${baseUrl}/admin-api/bundles/b`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const detail = (await (await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() })).json()) as {
      enabled: boolean;
    };
    expect(detail.enabled).toBe(false);

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(audit.items.some((e) => e.action === "bundle.update" && e.target === "b")).toBe(true);
  });

  test("404 for an unknown bundle", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin-api/bundles/:name", () => {
  test("deletes a bundle and records an audit entry", async () => {
    await startApp();
    await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "b", tools: [] }),
    });

    const res = await fetch(`${baseUrl}/admin-api/bundles/b`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/admin-api/bundles/b`, { headers: bearer() });
    expect(getRes.status).toBe(404);

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(audit.items.some((e) => e.action === "bundle.delete" && e.target === "b")).toBe(true);
  });

  test("404 for an unknown bundle", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/bundles/nobody`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin-api/tools", () => {
  test("lists tools across every registered client", async () => {
    await startApp();
    await reg("svc-a", [makeTool({ name: "t1" })]);
    await reg("svc-b", [makeTool({ name: "t2" })]);

    const res = await fetch(`${baseUrl}/admin-api/tools`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { client: string; tool: string }[] };
    expect(body.items.map((i) => `${i.client}__${i.tool}`).sort()).toEqual(["svc-a__t1", "svc-b__t2"]);
  });
});

describe("Session role gating — viewer cannot mutate bundles", () => {
  test("a viewer-role session gets 403 creating a bundle", async () => {
    await startApp();
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({ name: "b", tools: [] }),
    });
    expect(res.status).toBe(403);
  });

  test("a viewer-role session CAN read (GET) bundle routes", async () => {
    await startApp();
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/bundles`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    expect(res.status).toBe(200);
  });
});
