/**
 * Destructive-tool gating: confirmation / elevated-key enforcement in the proxy,
 * auto-gate config, explicit override, and __confirm stripping.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolSensitive, isToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import type { RestToolDefinition } from "../../mcp/types.js";

function makeTool(name = "get-users", method: RestToolDefinition["method"] = "GET"): RestToolDefinition {
  return { name, method, endpoint: `/${name}`, description: "d", inputSchema: { type: "object", properties: {} } };
}
async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const originalAutoGate = config.autoGateWriteMethods;
let capturedUrl = "";
function mockOkFetch(): void {
  capturedUrl = "";
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  __resetDbForTesting();
  (config as Record<string, unknown>).autoGateWriteMethods = false;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).autoGateWriteMethods = originalAutoGate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("destructive-tool gating", () => {
  test("a sensitive tool needs __confirm", async () => {
    await reg("svc", [makeTool("get-users")]);
    setToolSensitive("svc", "get-users", true);
    mockOkFetch();

    const noConfirm = await proxyToolCall("svc__get-users", {});
    expect(noConfirm.isError).toBe(true);
    expect(noConfirm.content[0].text.toLowerCase()).toContain("sensitive");

    const confirmed = await proxyToolCall("svc__get-users", { __confirm: true });
    expect(confirmed.isError).toBeUndefined();
  });

  test("an elevated key bypasses confirmation", async () => {
    await reg("svc", [makeTool("get-users")]);
    setToolSensitive("svc", "get-users", true);
    const { rawKey } = createMcpKey("k", null, null, null, null, true);
    mockOkFetch();
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  test("a non-elevated key still needs confirmation", async () => {
    await reg("svc", [makeTool("get-users")]);
    setToolSensitive("svc", "get-users", true);
    const { rawKey } = createMcpKey("k", null, null, null);
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBe(true);
  });

  test("auto-gate flags write methods when enabled", async () => {
    await reg("svc", [makeTool("del", "DELETE")]);
    (config as Record<string, unknown>).autoGateWriteMethods = true;
    expect(isToolSensitive("svc", "del", "DELETE")).toBe(true);
    mockOkFetch();
    expect((await proxyToolCall("svc__del", {})).isError).toBe(true);
    expect((await proxyToolCall("svc__del", { __confirm: true })).isError).toBeUndefined();
  });

  test("an explicit sensitive=false overrides the auto-gate", async () => {
    await reg("svc", [makeTool("del", "DELETE")]);
    (config as Record<string, unknown>).autoGateWriteMethods = true;
    setToolSensitive("svc", "del", false);
    expect(isToolSensitive("svc", "del", "DELETE")).toBe(false);
    mockOkFetch();
    expect((await proxyToolCall("svc__del", {})).isError).toBeUndefined();
  });

  test("__confirm is stripped and never sent upstream", async () => {
    await reg("svc", [makeTool("get-users")]);
    setToolSensitive("svc", "get-users", true);
    mockOkFetch();
    await proxyToolCall("svc__get-users", { __confirm: true });
    expect(capturedUrl).not.toContain("__confirm");
  });

  test("getClientDetail exposes the explicit sensitivity flag", async () => {
    await reg("svc", [makeTool("get-users")]);
    setToolSensitive("svc", "get-users", true);
    expect(registry.getClientDetail("svc")!.tools[0].sensitive).toBe(true);
  });
});

describe("sensitive flag via admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;

  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { adminRoutes } = await import("../../routes/admin.js");
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

  test("PATCH marks a tool sensitive", async () => {
    await reg("svc", [makeTool("get-users")]);
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sensitive: true }),
    });
    expect(res.status).toBe(200);
    expect(registry.getClientDetail("svc")!.tools[0].sensitive).toBe(true);
  });
});
