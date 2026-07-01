/**
 * Central regression test for the whole persistence feature: an admin
 * enable/disable or guard decision must survive the backend re-registering
 * itself after this process restarts.
 *
 * `register()`'s DB round-trip (upsert + RETURNING) doesn't distinguish
 * "first-ever registration" from "re-registration after this process forgot
 * about the client" — both paths read the same SQLite row. So clearing a
 * client's in-memory entry (which is exactly what `unregister()` does, and
 * exactly what an empty `Registry.clients` Map looks like right after a
 * fresh process boot) and then re-registering exercises the identical code
 * path a real restart would.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import type { RestToolDefinition } from "../types.js";

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

describe("Persisted enabled/guards survive re-registration after this process 'forgets' the client", () => {
  test("a disabled tool stays disabled across unregister + re-register", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolEnabled("svc", "get-users", false);

    // Simulate this process no longer having the client live in memory —
    // equivalent to what a fresh boot's empty Map looks like.
    await registry.unregister("svc");
    expect(registry.getClient("svc")).toBeUndefined();

    // The backend re-registers itself, as it does on every real restart.
    await reg("svc", [makeTool({ name: "get-users" })]);

    expect(registry.resolveTool("svc__get-users")?.tool.enabled).toBe(false);
  });

  test("a disabled client stays disabled across unregister + re-register", async () => {
    await reg("svc");
    await registry.setClientEnabled("svc", false);

    await registry.unregister("svc");
    await reg("svc");

    expect(registry.getClient("svc")?.enabled).toBe(false);
  });

  test("a tool guard survives unregister + re-register", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 17 });

    await registry.unregister("svc");
    await reg("svc", [makeTool({ name: "get-users" })]);

    expect(registry.resolveTool("svc__get-users")?.tool.guards?.rateLimitPerMin).toBe(17);
  });
});

describe("Persisted enabled state survives a real SQLite file close + reopen", () => {
  const dbDir = "C:\\Users\\carlo\\AppData\\Local\\Temp\\claude\\C--Users-carlo-Desktop-test-1\\389c3acb-7605-40d2-86eb-81b21edd9c9a\\scratchpad";
  const dbPath = `${dbDir}\\registry-reload-test.db`;

  afterEach(() => {
    __resetDbForTesting();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  test("enabled: false written before a close is read back after reopening the same file", async () => {
    mkdirSync(dbDir, { recursive: true });
    if (existsSync(dbPath)) rmSync(dbPath);

    __resetDbForTesting(dbPath);
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("svc", false);

    // Close and reopen at the SAME file path — this is a real durability
    // test, not just an in-memory-Map-reset simulation.
    __resetDbForTesting(dbPath);
    await registry.unregister("svc"); // clear whatever the reopen left in-memory, if anything
    await reg("svc", [makeTool({ name: "get-users" })]);

    expect(registry.getClient("svc")?.enabled).toBe(false);
  });
});
