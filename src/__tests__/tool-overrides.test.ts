/**
 * Tool presentation overrides — registry application + admin route.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import type { RestToolDefinition } from "../types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Original description",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "orig" } } },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("tool overrides — registry", () => {
  test("description override is reflected in advertised tools, original untouched", async () => {
    await reg("svc");
    await registry.setToolOverride("svc", "get-users", { description: "Better description" });
    expect(registry.getAllMcpTools().find((t) => t.name === "svc__get-users")?.description).toBe("Better description");
    expect(registry.resolveTool("svc__get-users")?.tool.description).toBe("Original description");
  });

  test("param override merges into inputSchema without mutating the stored schema", async () => {
    await reg("svc");
    await registry.setToolOverride("svc", "get-users", { params: { limit: { description: "max rows" } } });
    const advertised = registry.getMcpToolsForClient("svc").find((t) => t.name === "svc__get-users");
    expect((advertised?.inputSchema.properties as Record<string, { description: string }>).limit.description).toBe("max rows");
    const orig = registry.resolveTool("svc__get-users")?.tool.inputSchema.properties as Record<string, { description: string }>;
    expect(orig.limit.description).toBe("orig");
  });

  test("clearing the override restores the original", async () => {
    await reg("svc");
    await registry.setToolOverride("svc", "get-users", { description: "X" });
    await registry.setToolOverride("svc", "get-users", null);
    expect(registry.getAllMcpTools().find((t) => t.name === "svc__get-users")?.description).toBe("Original description");
  });

  test("override survives re-registration (backend reboot)", async () => {
    await reg("svc");
    await registry.setToolOverride("svc", "get-users", { description: "Persisted" });
    await reg("svc");
    expect(registry.getAllMcpTools().find((t) => t.name === "svc__get-users")?.description).toBe("Persisted");
  });

  test("returns false for an unknown tool", async () => {
    await reg("svc");
    expect(await registry.setToolOverride("svc", "nope", { description: "x" })).toBe(false);
  });
});

describe("tool overrides — admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;

  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
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

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => { server = null; resolve(); });
      else resolve();
    });
  });

  function bearer(): Record<string, string> {
    return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
  }

  test("PATCH with overrides updates the advertised description", async () => {
    await reg("svc");
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ overrides: { description: "From the admin UI" } }),
    });
    expect(res.status).toBe(200);
    expect(registry.getAllMcpTools().find((t) => t.name === "svc__get-users")?.description).toBe("From the admin UI");
  });

  test("400 for a malformed override", async () => {
    await reg("svc");
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ overrides: { params: "nope" } }),
    });
    expect(res.status).toBe(400);
  });
});
