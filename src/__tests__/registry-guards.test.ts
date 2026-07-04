import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../mcp/registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import type { RestToolDefinition } from "../mcp/types.js";

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
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
});

describe("Registry.setClientGuards", () => {
  test("returns false for an unknown client", async () => {
    expect(await registry.setClientGuards("nobody", { circuitBreaker: { failureThreshold: 5 } })).toBe(false);
  });

  test("persists and applies a circuit-breaker override to a live client", async () => {
    await reg("svc");
    const ok = await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 7, resetTimeoutMs: 9000 } });
    expect(ok).toBe(true);

    const client = registry.getClient("svc");
    expect(client?.guards?.circuitBreaker?.failureThreshold).toBe(7);
    expect(client?.guards?.circuitBreaker?.resetTimeoutMs).toBe(9000);
  });

  test("null clears a previously-set guard", async () => {
    await reg("svc");
    await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 7 } });
    await registry.setClientGuards("svc", null);

    const client = registry.getClient("svc");
    expect(client?.guards).toBeUndefined();
  });

  test("guard survives unregister + re-register (unlike enabled it is not re-registration-preserving by rule — it IS preserved because unregister never purges SQLite)", async () => {
    await reg("svc");
    await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 3 } });
    await registry.unregister("svc");
    await reg("svc");

    const client = registry.getClient("svc");
    expect(client?.guards?.circuitBreaker?.failureThreshold).toBe(3);
  });
});

describe("Registry.setToolGuards", () => {
  test("returns false for an unknown client/tool", async () => {
    expect(await registry.setToolGuards("nobody", "nothing", { rateLimitPerMin: 10 })).toBe(false);
    await reg("svc");
    expect(await registry.setToolGuards("svc", "nonexistent-tool", { rateLimitPerMin: 10 })).toBe(false);
  });

  test("persists and applies rate limit + timeout + allowed key hashes to a live tool", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const ok = await registry.setToolGuards("svc", "get-users", {
      rateLimitPerMin: 5,
      timeoutMs: 1500,
      allowedKeyHashes: ["abc123"],
    });
    expect(ok).toBe(true);

    const resolved = registry.resolveTool("svc__get-users");
    expect(resolved?.tool.guards?.rateLimitPerMin).toBe(5);
    expect(resolved?.tool.guards?.timeoutMs).toBe(1500);
    expect(resolved?.tool.guards?.allowedKeyHashes).toEqual(["abc123"]);
  });

  test("null clears a previously-set tool guard", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 5 });
    await registry.setToolGuards("svc", "get-users", null);

    const resolved = registry.resolveTool("svc__get-users");
    expect(resolved?.tool.guards).toBeUndefined();
  });

  test("tool guard survives re-registration", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 42 });
    await reg("svc", [makeTool({ name: "get-users" })]);

    const resolved = registry.resolveTool("svc__get-users");
    expect(resolved?.tool.guards?.rateLimitPerMin).toBe(42);
  });

  test("deleting a tool (absent from re-registration) drops its guard row (no orphan resurrection)", async () => {
    await reg("svc", [makeTool({ name: "old-tool" })]);
    await registry.setToolGuards("svc", "old-tool", { rateLimitPerMin: 99 });

    // Re-register without old-tool — it's deleted, cascading to tool_guards.
    await reg("svc", [makeTool({ name: "new-tool" })]);
    // Bringing old-tool back later must NOT resurrect the old guard.
    await reg("svc", [makeTool({ name: "old-tool" }), makeTool({ name: "new-tool" })]);

    const resolved = registry.resolveTool("svc__old-tool");
    expect(resolved?.tool.guards).toBeUndefined();
  });
});
