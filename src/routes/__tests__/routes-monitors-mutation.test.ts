/**
 * Stryker mutation-testing backstop for src/routes/admin/monitors.ts —
 * domain 8. Baseline: 3 mutants, 0 killed / 3 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { registry } from "../../mcp/registry.js";
import { setMonitor } from "../../observability/monitor.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key-monitors";
const CLIENT = "svc";
const tool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: {} },
};

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app);
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
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

async function addMonitor(): Promise<void> {
  await registry.register(CLIENT, [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
  const { id } = getDb()
    .query(
      `INSERT INTO tool_examples (client_name, tool_name, label, args_json, created_at) VALUES (?, ?, 'ex', '{}', ?) RETURNING id`,
    )
    .get(CLIENT, tool.name, Date.now()) as { id: number };
  await setMonitor(CLIENT, tool.name, { exampleId: id, intervalMinutes: 5, enabled: true });
}

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/monitors", () => {
  // Kills 14:67-16:2 BlockStatement (the whole handler body emptied --
  // no response would ever be sent) and 14:20-14:31 StringLiteral (the
  // "/monitors" route path emptied, which would mount at "/" instead,
  // also matching unrelated paths).
  test("is reachable at the exact /monitors path and returns 200", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/monitors`, { headers: bearer() });
    expect(res.status).toBe(200);
  });

  test("an unrelated path is NOT served by the monitors route", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/totally-unrelated-path`, { headers: bearer() });
    expect(res.status).toBe(404);
  });

  // Kills 15:24-15:49 ObjectLiteral (the `{ items: listMonitors() }`
  // response body emptied to `{}`) -- assert the exact shape, both
  // empty and non-empty.
  test("returns the exact { items: [] } shape when no monitors are configured", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/monitors`, { headers: bearer() });
    const body = await res.json();
    expect(body).toEqual({ items: [] });
  });

  test("returns every configured monitor under the items key", async () => {
    await startApp();
    await addMonitor();
    const res = await fetch(`${baseUrl}/admin-api/monitors`, { headers: bearer() });
    const body = (await res.json()) as { items: Array<{ toolName: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].toolName).toBe(tool.name);
  });

  test("requires admin auth", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/monitors`);
    expect(res.status).toBe(401);
  });
});
