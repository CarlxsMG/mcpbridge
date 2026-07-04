/**
 * Consumers + monthly quota: CRUD, key linkage (FK set-null), proxy enforcement.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { proxyToolCall } from "../proxy.js";
import {
  createConsumer,
  updateConsumer,
  deleteConsumer,
  listConsumers,
  checkConsumerQuota,
  checkEndUserRateLimit,
} from "../consumers.js";
import { createMcpKey, getMcpKey } from "../security/mcp-key-store.js";
import type { RestToolDefinition } from "../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
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

  test("endUserRateLimitPerMin round-trips through create/update", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, endUserRateLimitPerMin: 10, actor: null });
    expect(c.endUserRateLimitPerMin).toBe(10);
    expect(updateConsumer(c.id, { endUserRateLimitPerMin: 20 })?.endUserRateLimitPerMin).toBe(20);
    expect(updateConsumer(c.id, { endUserRateLimitPerMin: null })?.endUserRateLimitPerMin).toBeNull();
  });

  test("checkEndUserRateLimit: unset consumer never limits", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, actor: null });
    for (let i = 0; i < 20; i++) {
      expect(checkEndUserRateLimit(c.id, "alice").limited).toBe(false);
    }
  });

  test("checkEndUserRateLimit: limits per end-user once opted in, independently per id", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: null, endUserRateLimitPerMin: 2, actor: null });
    expect(checkEndUserRateLimit(c.id, "alice").limited).toBe(false);
    expect(checkEndUserRateLimit(c.id, "alice").limited).toBe(false);
    expect(checkEndUserRateLimit(c.id, "alice").limited).toBe(true);
    // A different end-user under the same consumer is unaffected.
    expect(checkEndUserRateLimit(c.id, "bob").limited).toBe(false);
  });

  test("checkEndUserRateLimit: unknown consumer fails open", () => {
    expect(checkEndUserRateLimit(999999, "alice").limited).toBe(false);
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

describe("proxy end-user rate limit enforcement", () => {
  test("blocks the caller-asserted end-user id that exceeds the per-minute cap, others unaffected", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: null, endUserRateLimitPerMin: 2, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();

    expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" })).isError).toBeUndefined();
    expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" })).isError).toBeUndefined();
    const third = await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" });
    expect(third.isError).toBe(true);
    expect(third.content[0].text.toLowerCase()).toContain("end-user rate limit");

    // A different end-user under the same key/consumer is unaffected.
    expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "bob" })).isError).toBeUndefined();
  });

  test("a consumer that hasn't opted in is never blocked regardless of asserted identity", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: null, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();
    for (let i = 0; i < 5; i++) {
      expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" })).isError).toBeUndefined();
    }
  });

  test("a call asserting no identity bypasses the check entirely", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: null, endUserRateLimitPerMin: 1, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();
    for (let i = 0; i < 3; i++) {
      expect((await proxyToolCall("svc__get-users", {}, rawKey)).isError).toBeUndefined();
    }
  });

  test("header wins over __end_user arg when both are present and disagree", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: null, endUserRateLimitPerMin: 1, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    mockOkFetch();

    // Exhaust "alice" via the header.
    expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" })).isError).toBeUndefined();
    // header="alice" (exhausted) + arg="bob" (fresh) -> header wins, still blocked.
    const blocked = await proxyToolCall("svc__get-users", { __end_user: "bob" }, rawKey, { endUserId: "alice" });
    expect(blocked.isError).toBe(true);

    // Only the arg present (no header) is limited independently.
    expect((await proxyToolCall("svc__get-users", { __end_user: "carol" }, rawKey)).isError).toBeUndefined();
    const blockedArgOnly = await proxyToolCall("svc__get-users", { __end_user: "carol" }, rawKey);
    expect(blockedArgOnly.isError).toBe(true);
  });

  test("__end_user is stripped and never sent upstream", async () => {
    await reg("svc");
    const c = createConsumer({ name: "team", monthlyQuota: null, endUserRateLimitPerMin: 5, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, c.id);
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await proxyToolCall("svc__get-users", { __end_user: "alice" }, rawKey);
    expect(capturedUrl).not.toContain("__end_user");
  });

  test("a key with no consumer is unaffected by end-user limiting even if it asserts an identity", async () => {
    await reg("svc");
    const { rawKey } = createMcpKey("k", null, null, null);
    mockOkFetch();
    for (let i = 0; i < 3; i++) {
      expect((await proxyToolCall("svc__get-users", {}, rawKey, { endUserId: "alice" })).isError).toBeUndefined();
    }
  });
});
