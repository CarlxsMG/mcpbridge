/**
 * Stryker mutation-testing backstop for src/routes/introspection.ts —
 * domain 8. Baseline: 28 mutants, 0 killed / 28 survived — zero test
 * coverage of any kind existed before this. All line:col citations below
 * were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import * as loggerMod from "../../logger.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key-introspection";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { introspectionRoutes } = await import("../../routes/introspection.js");
  const app = express();
  app.use(express.json());
  introspectionRoutes(app);
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

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

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

describe("GET /clients", () => {
  // Kills 7:57-41:2 BlockStatement (the whole introspectionRoutes body
  // emptied -- nothing mounted at all) and 9:11-9:21 StringLiteral (the
  // "/clients" route path emptied, matching "/" instead).
  test("an unrelated path is not served by introspectionRoutes", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/totally-unrelated-path`, { headers: bearer() });
    expect(res.status).toBe(404);
  });

  // Kills 9:68-18:4 BlockStatement (this handler's own body emptied),
  // 10:48-16:7 ArrowFunction (the .map() callback replaced with `()
  // => undefined`, which would make every entry `undefined`), 10:56-16:6
  // ObjectLiteral (the per-client mapped object emptied to {}), and
  // 17:14-25 ObjectLiteral (the `{ clients }` response wrapper emptied).
  test("returns the exact per-client shape for every registered client", async () => {
    await startApp();
    await reg("svc-a", [makeTool("t1"), makeTool("t2")]);
    const res = await fetch(`${baseUrl}/clients`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{ name: string; ip: string; status: string; tools_count: number; health_url: string }>;
    };
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]).toMatchObject({
      name: "svc-a",
      ip: "1.2.3.4",
      status: "healthy",
      tools_count: 2,
      health_url: "http://example.com/health",
    });
  });
});

describe("GET /clients/:name/tools", () => {
  // Kills 21:11-21:33 StringLiteral (the "/clients/:name/tools" route
  // path emptied) and 21:97-28:4 BlockStatement (the whole handler
  // emptied) and 27:14-23 ObjectLiteral (the `{ tools }` response
  // wrapper emptied).
  test("returns the tools array for a known client", async () => {
    await startApp();
    await reg("svc-b", [makeTool("only-tool")]);
    const res = await fetch(`${baseUrl}/clients/svc-b/tools`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("only-tool");
  });

  // Kills 23:9-23:15 BooleanLiteral/ConditionalExpression true/false (the
  // `!tools` guard) and 23:17-26:6 BlockStatement (the not-found branch
  // emptied) and 24:21-24:39 / 24:41-24:59 StringLiteral
  // ("CLIENT_NOT_FOUND"/"Client not found" emptied).
  test("returns the exact CLIENT_NOT_FOUND 404 for an unknown client", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/clients/no-such-client/tools`, { headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    expect(body.error.message).toBe("Client not found");
  });
});

describe("DELETE /clients/:name", () => {
  // Kills 32:14-32:30 StringLiteral (the "/clients/:name" route path
  // emptied), 32:100-40:4 BlockStatement (the whole handler emptied),
  // 38:9-38:15 / 38:17-38:38 StringLiteral (the "info"/"Client
  // unregistered" log call literals emptied), 38:40-38:65 ObjectLiteral
  // (the log meta `{ name }` emptied), 39:14-39:63 ObjectLiteral (the
  // `{ status, name }` response wrapper emptied), and 39:24-39:38
  // StringLiteral (the "unregistered" status literal emptied).
  test("unregisters a known client, logs it, and returns the exact response shape", async () => {
    await startApp();
    await reg("svc-c", [makeTool("t")]);
    const logSpy = spyOn(loggerMod, "log");
    try {
      const res = await fetch(`${baseUrl}/clients/svc-c`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; name: string };
      expect(body).toEqual({ status: "unregistered", name: "svc-c" });
      expect(logSpy).toHaveBeenCalledWith("info", "Client unregistered", { name: "svc-c" });
      expect(registry.getClientTools("svc-c")).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  // Kills 34:9-34:17 BooleanLiteral/ConditionalExpression true/false (the
  // `!removed` guard) and 34:19-37:6 BlockStatement (the not-found
  // branch emptied) and 35:21-35:39 / 35:41-35:59 StringLiteral
  // ("CLIENT_NOT_FOUND"/"Client not found" emptied).
  test("returns the exact CLIENT_NOT_FOUND 404 for an unknown client", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/clients/no-such-client`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");
    expect(body.error.message).toBe("Client not found");
  });
});
