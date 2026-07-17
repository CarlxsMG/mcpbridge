/**
 * Proxy-level enforcement of MCP key scopes: a DB-managed key carrying scopes
 * may only call tools within those scopes; unrestricted keys and the
 * no-token admin path are unaffected.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import type { RestToolDefinition } from "../../mcp/types.js";

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

async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function mockOkFetch(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("proxy MCP key scope enforcement", () => {
  test("a client-scoped key can call an in-scope tool", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("scoped", { clients: ["svc"] }, null, null);
    mockOkFetch();
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  test("a scoped key is rejected for an out-of-scope tool (before any fetch)", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("scoped", { clients: ["other"] }, null, null);
    // Intentionally do NOT mock fetch — the call must be rejected before reaching it.
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBe(true);
    expect((res.content[0].text ?? "").toLowerCase()).toContain("not authorized");
  });

  test("a tool-scoped key can call exactly the granted tool", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("scoped", { tools: ["svc__get-users"] }, null, null);
    mockOkFetch();
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  test("an unrestricted key (null scopes) can call any tool", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("open", null, null, null);
    mockOkFetch();
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  test("no callerToken => no scope enforcement (admin test path)", async () => {
    await reg("svc");
    mockOkFetch();
    const res = await proxyToolCall("svc__get-users", {});
    expect(res.isError).toBeUndefined();
  });
});
