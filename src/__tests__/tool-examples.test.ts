/**
 * Saved tool examples (playground) — module + admin routes.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { listExamples, createExample, deleteExample } from "../tool-examples.js";
import type { RestToolDefinition } from "../types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "search",
    method: "GET",
    endpoint: "/search",
    description: "search",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };
}
async function reg(): Promise<void> {
  await registry.register("svc", [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

describe("tool-examples — module", () => {
  test("create + list + delete round-trip", async () => {
    await reg();
    const created = createExample("svc", "search", "basic", { q: "hello" }, "tester");
    expect(typeof created).toBe("object");
    expect(listExamples("svc", "search")).toHaveLength(1);
    expect(listExamples("svc", "search")[0].args).toEqual({ q: "hello" });
    const id = (created as { id: number }).id;
    expect(deleteExample("svc", "search", id)).toBe(true);
    expect(listExamples("svc", "search")).toHaveLength(0);
  });

  test("rejects an unknown tool and non-object args", async () => {
    await reg();
    expect(createExample("svc", "ghost", "x", { q: "1" }, null)).toBe("TOOL_NOT_FOUND");
    expect(createExample("svc", "search", "x", [1, 2, 3], null)).toBe("INVALID_ARGS");
  });

  test("examples are cascade-deleted when the tool is forgotten", async () => {
    await reg();
    createExample("svc", "search", "basic", { q: "hi" }, null);
    await registry.forgetClient("svc");
    expect(listExamples("svc", "search")).toHaveLength(0);
  });

  test("delete is scoped to the tool (wrong tool -> false)", async () => {
    await reg();
    const created = createExample("svc", "search", "basic", { q: "hi" }, null) as { id: number };
    expect(deleteExample("svc", "other", created.id)).toBe(false);
  });
});

describe("tool-examples — admin route", () => {
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
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });
  function bearer(): Record<string, string> {
    return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
  }

  test("POST creates, GET lists, DELETE removes", async () => {
    await reg();
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/clients/svc/tools/search/examples`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ label: "basic", args: { q: "hello" } }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: number };

    const list = await fetch(`${baseUrl}/admin-api/clients/svc/tools/search/examples`, { headers: bearer() });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);

    const del = await fetch(`${baseUrl}/admin-api/clients/svc/tools/search/examples/${id}`, {
      method: "DELETE",
      headers: bearer(),
    });
    expect(del.status).toBe(200);
  });

  test("POST without a label returns 400", async () => {
    await reg();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/search/examples`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ args: { q: "x" } }),
    });
    expect(res.status).toBe(400);
  });
});
