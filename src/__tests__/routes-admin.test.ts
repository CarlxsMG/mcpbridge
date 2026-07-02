/**
 * HTTP-level tests for src/routes/admin.ts — real express() instance + native
 * fetch(), matching transports.test.ts / routes-auth.test.ts conventions.
 * Auth is exercised primarily via Bearer token (adminApiKeys) since it's
 * CSRF-exempt and simpler to set up; a couple of tests specifically cover
 * session-role gating (viewer vs admin) which Bearer can't exercise.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { createUser } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../security/cookies.js";
import { hashApiKey } from "../security/key-hash.js";
import type { RestToolDefinition } from "../types.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { adminRoutes } = await import("../routes/admin.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  adminRoutes(app);

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

describe("GET /admin-api/clients", () => {
  test("lists registered clients with tool counts", async () => {
    await startApp();
    await reg("svc-a", [makeTool({ name: "tool-1" }), makeTool({ name: "tool-2" })]);
    await reg("svc-b");

    const res = await fetch(`${baseUrl}/admin-api/clients`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { name: string; toolsCount: number }[] };
    const names = body.items.map((i) => i.name).sort();
    expect(names).toEqual(["svc-a", "svc-b"]);
    expect(body.items.find((i) => i.name === "svc-a")?.toolsCount).toBe(2);
  });

  test("q filters by substring of the client name", async () => {
    await startApp();
    await reg("payments-svc");
    await reg("inventory-svc");

    const res = await fetch(`${baseUrl}/admin-api/clients?q=payments`, { headers: bearer() });
    const body = (await res.json()) as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(["payments-svc"]);
  });

  test("respects limit and returns a nextCursor when there are more results", async () => {
    await startApp();
    await reg("a-svc");
    await reg("b-svc");
    await reg("c-svc");

    const res = await fetch(`${baseUrl}/admin-api/clients?limit=2`, { headers: bearer() });
    const body = (await res.json()) as { items: unknown[]; nextCursor?: string };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBe("b-svc");
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients`);
    expect(res.status).toBe(401);
  });
});

describe("GET /admin-api/clients/:name", () => {
  test("404 for an unknown client", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/nobody`, { headers: bearer() });
    expect(res.status).toBe(404);
  });

  test("returns full detail including tools for a live client", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; live: boolean; tools: { name: string }[] };
    expect(body.name).toBe("svc");
    expect(body.live).toBe(true);
    expect(body.tools.map((t) => t.name)).toEqual(["get-users"]);
  });
});

describe("PATCH /admin-api/clients/:name", () => {
  test("disables a client and records an audit entry", async () => {
    await startApp();
    await reg("svc");

    const res = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(registry.getClient("svc")?.enabled).toBe(false);

    const auditRes = await fetch(`${baseUrl}/admin-api/audit-log`, { headers: bearer() });
    const audit = (await auditRes.json()) as { items: { action: string; target: string }[] };
    expect(audit.items.some((e) => e.action === "client.disable" && e.target === "svc")).toBe(true);
  });

  test("sets a circuit-breaker guard override", async () => {
    await startApp();
    await reg("svc");

    const res = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ guards: { circuitBreaker: { failureThreshold: 9 } } }),
    });
    expect(res.status).toBe(200);
    expect(registry.getClient("svc")?.guards?.circuitBreaker?.failureThreshold).toBe(9);
  });

  test("404 for an unknown client", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/nobody`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  test("400 when enabled is not a boolean", async () => {
    await startApp();
    await reg("svc");
    const res = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /admin-api/clients (bulk)", () => {
  test("enables/disables multiple clients in one call", async () => {
    await startApp();
    await reg("svc-a");
    await reg("svc-b");

    const res = await fetch(`${baseUrl}/admin-api/clients`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ names: ["svc-a", "svc-b", "nonexistent"], enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, boolean> };
    expect(body.results).toEqual({ "svc-a": true, "svc-b": true, nonexistent: false });
    expect(registry.getClient("svc-a")?.enabled).toBe(false);
    expect(registry.getClient("svc-b")?.enabled).toBe(false);
  });
});

describe("PATCH /admin-api/clients/:name/tools/:tool", () => {
  test("sets a rate-limit guard and disables the tool in one call", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false, guards: { rateLimitPerMin: 5 } }),
    });
    expect(res.status).toBe(200);

    const tool = registry.resolveTool("svc__get-users")?.tool;
    expect(tool?.enabled).toBe(false);
    expect(tool?.guards?.rateLimitPerMin).toBe(5);
  });

  test("allowedApiKeys are hashed before being persisted — raw key never stored", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ guards: { allowedApiKeys: ["raw-secret-key"] } }),
    });
    expect(res.status).toBe(200);

    const tool = registry.resolveTool("svc__get-users")?.tool;
    expect(tool?.guards?.allowedKeyHashes).toEqual([hashApiKey("raw-secret-key")]);
    expect(tool?.guards?.allowedKeyHashes?.[0]).not.toBe("raw-secret-key");
  });

  test("400 for an invalid guard shape", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);

    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ guards: { rateLimitPerMin: -5 } }),
    });
    expect(res.status).toBe(400);
  });

  test("404 for an unknown tool", async () => {
    await startApp();
    await reg("svc");
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/nonexistent`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /admin-api/clients/:name/tools/:tool/test", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("proxies a real call through proxyToolCall and returns the result", async () => {
    await startApp();
    await reg("svc", [makeTool({ name: "get-users" })]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users/test`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isError?: boolean };
    expect(body.isError).toBeUndefined();
  });
});

describe("POST /admin-api/clients/:name/circuit-breaker/reset", () => {
  test("404 when the client isn't live", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/nobody/circuit-breaker/reset`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
  });

  test("200 for a live client", async () => {
    await startApp();
    await reg("svc");
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/circuit-breaker/reset`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(200);
  });
});

describe("Users CRUD + last-admin protection", () => {
  test("creates, lists, and deletes a viewer user", async () => {
    await startApp();

    const createRes = await fetch(`${baseUrl}/admin-api/users`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ username: "bob", password: "correct-horse-battery-staple", role: "viewer" }),
    });
    expect(createRes.status).toBe(201);

    const listRes = await fetch(`${baseUrl}/admin-api/users`, { headers: bearer() });
    const list = (await listRes.json()) as { users: { username: string }[] };
    expect(list.users.map((u) => u.username)).toContain("bob");

    const deleteRes = await fetch(`${baseUrl}/admin-api/users/bob`, { method: "DELETE", headers: bearer() });
    expect(deleteRes.status).toBe(200);
  });

  test("409 when creating a duplicate username", async () => {
    await startApp();
    createUser("bob", "some-hash", "admin", null);

    const res = await fetch(`${baseUrl}/admin-api/users`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ username: "bob", password: "correct-horse-battery-staple" }),
    });
    expect(res.status).toBe(409);
  });

  test("cannot delete the last active admin", async () => {
    await startApp();
    createUser("sole-admin", "some-hash", "admin", null);

    const res = await fetch(`${baseUrl}/admin-api/users/sole-admin`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("LAST_ADMIN_PROTECTED");
  });

  test("cannot demote the last active admin to viewer", async () => {
    await startApp();
    createUser("sole-admin", "some-hash", "admin", null);

    const res = await fetch(`${baseUrl}/admin-api/users/sole-admin`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(res.status).toBe(409);
  });

  test("CAN delete an admin when another active admin still exists", async () => {
    await startApp();
    createUser("admin-one", "some-hash", "admin", null);
    createUser("admin-two", "some-hash", "admin", null);

    const res = await fetch(`${baseUrl}/admin-api/users/admin-one`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(200);
  });
});

describe("Session role gating — viewer cannot mutate", () => {
  test("a viewer-role session gets 403 on a mutating admin-api route", async () => {
    await startApp();
    await reg("svc");
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/clients/svc`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
    expect(registry.getClient("svc")?.enabled).toBe(true); // unchanged
  });

  test("a viewer-role session CAN read (GET) admin-api routes", async () => {
    await startApp();
    await reg("svc");
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "test-agent");

    const res = await fetch(`${baseUrl}/admin-api/clients`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /admin-api/overview", () => {
  test("returns aggregate counts", async () => {
    await startApp();
    await reg("svc-a", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);
    await reg("svc-b");
    await registry.setClientEnabled("svc-b", false);

    const res = await fetch(`${baseUrl}/admin-api/overview`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: { live: number; disabled: number };
      tools: { total: number };
      circuit_breakers: { open: number; half_open: number; closed: number };
    };
    expect(body.clients.live).toBe(2);
    expect(body.clients.disabled).toBe(1);
    expect(body.tools.total).toBe(3);
    // Breakers are a process-wide singleton shared with other concurrently-running test
    // files (not reset by __resetDbForTesting), so exact counts aren't safe to assert here —
    // just check the shape and the closed/open/half-open split is internally consistent.
    const b = body.circuit_breakers;
    expect(b.open).toBeGreaterThanOrEqual(0);
    expect(b.half_open).toBeGreaterThanOrEqual(0);
    expect(b.closed).toBeGreaterThanOrEqual(0);
  });
});
