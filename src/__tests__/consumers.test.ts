/**
 * Consumers + monthly quota: CRUD, key linkage (FK set-null), proxy enforcement.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { proxyToolCall } from "../proxy.js";
import { createConsumer, updateConsumer, deleteConsumer, listConsumers, checkConsumerQuota } from "../consumers.js";
import { createMcpKey, getMcpKey } from "../security/mcp-key-store.js";
import type { RestToolDefinition } from "../types.js";

function makeTool(): RestToolDefinition {
  return { name: "get-users", method: "GET", endpoint: "/users", description: "list", inputSchema: { type: "object", properties: {} } };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function mockOkFetch(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("consumers", () => {
  test("CRUD", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 100, actor: "t" });
    expect(listConsumers()).toHaveLength(1);
    expect(updateConsumer(c.id, { monthlyQuota: 200 })?.monthlyQuota).toBe(200);
    expect(deleteConsumer(c.id)).toBe(true);
    expect(listConsumers()).toHaveLength(0);
  });

  test("deleting a consumer nulls its keys' consumer_id (FK set-null)", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, actor: null });
    const { record } = createMcpKey("k", null, null, null, c.id);
    expect(getMcpKey(record.id)?.consumerId).toBe(c.id);
    deleteConsumer(c.id);
    expect(getMcpKey(record.id)?.consumerId).toBeNull();
  });

  test("checkConsumerQuota reflects usage", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 5, actor: null });
    expect(checkConsumerQuota(c.id).exceeded).toBe(false);
    const unlimited = createConsumer({ name: "team-b", monthlyQuota: null, actor: null });
    expect(checkConsumerQuota(unlimited.id).exceeded).toBe(false);
  });
});

describe("proxy quota enforcement", () => {
  test("blocks once a consumer is at its monthly cap", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: 2, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();

    expect((await proxyToolCall("svc__get-users", {}, rawKey)).isError).toBeUndefined();
    expect((await proxyToolCall("svc__get-users", {}, rawKey)).isError).toBeUndefined();
    const third = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(third.isError).toBe(true);
    expect(third.content[0].text.toLowerCase()).toContain("quota");
  });

  test("an unlimited consumer is never blocked", async () => {
    await reg("svc");
    const c = createConsumer({ name: "unl", monthlyQuota: null, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();
    for (let i = 0; i < 5; i++) {
      expect((await proxyToolCall("svc__get-users", {}, rawKey)).isError).toBeUndefined();
    }
  });

  test("a key with no consumer is unaffected by quotas", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("k", null, null, null);
    mockOkFetch();
    for (let i = 0; i < 3; i++) {
      expect((await proxyToolCall("svc__get-users", {}, rawKey)).isError).toBeUndefined();
    }
  });
});
