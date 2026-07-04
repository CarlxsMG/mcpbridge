/**
 * HTTP-level tests for src/routes/policies.ts.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import type { RestToolDefinition } from "../mcp/types.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { policyRoutes } = await import("../routes/policies.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  policyRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
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

describe("policy routes", () => {
  test("create / list / duplicate / delete", async () => {
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "strict", rateLimitPerMin: 10 }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: number };

    const dup = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "strict" }),
    });
    expect(dup.status).toBe(409);

    const list = (await (await fetch(`${baseUrl}/admin-api/policies`, { headers: bearer() })).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);

    const del = await fetch(`${baseUrl}/admin-api/policies/${id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
  });

  test("apply a policy to tools", async () => {
    await startApp();
    await registry.register(
      "svc",
      [makeTool("t")],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    const create = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "p", rateLimitPerMin: 5 }),
    });
    const { id } = (await create.json()) as { id: number };

    const apply = await fetch(`${baseUrl}/admin-api/policies/${id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ tools: [{ client: "svc", tool: "t" }] }),
    });
    expect(apply.status).toBe(200);
    const result = (await apply.json()) as { applied: number };
    expect(result.applied).toBe(1);
    expect(registry.resolveTool("svc__t")?.tool.guards?.rateLimitPerMin).toBe(5);
  });

  test("apply requires bundle or tools", async () => {
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/policies`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "p" }),
    });
    const { id } = (await create.json()) as { id: number };
    const apply = await fetch(`${baseUrl}/admin-api/policies/${id}/apply`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(apply.status).toBe(400);
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/policies`);
    expect(res.status).toBe(401);
  });
});
