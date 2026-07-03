import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../registry.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { createBundle, getBundleDetail } from "../bundles.js";
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

describe("Registry.forgetClient", () => {
  test("returns false when the client has no live state and no SQLite row", async () => {
    expect(await registry.forgetClient("never-existed")).toBe(false);
  });

  test("tears down live in-memory state, same as unregister", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(await registry.forgetClient("svc")).toBe(true);

    expect(registry.getClient("svc")).toBeUndefined();
    expect(registry.resolveTool("svc__get-users")).toBeUndefined();
  });

  test("purges SQLite so a disabled tool's guard does NOT survive re-registration (unlike plain unregister)", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolEnabled("svc", "get-users", false);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 5 });

    await registry.forgetClient("svc");
    await reg("svc", [makeTool({ name: "get-users" })]);

    const resolved = registry.resolveTool("svc__get-users");
    expect(resolved?.tool.enabled).toBe(true); // back to the default — no stale disable
    expect(resolved?.tool.guards).toBeUndefined(); // guard is gone too
  });

  test("regression: plain unregister() (unlike forgetClient) preserves the disabled state — proves the two are genuinely different", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolEnabled("svc", "get-users", false);

    await registry.unregister("svc");
    await reg("svc", [makeTool({ name: "get-users" })]);

    expect(registry.resolveTool("svc__get-users")?.tool.enabled).toBe(false);
  });

  test("forgetting a client that exists only as a SQLite row (never live in this call) still purges it", async () => {
    await reg("svc");
    await registry.unregister("svc"); // now: SQL row exists, but not live in memory

    expect(await registry.forgetClient("svc")).toBe(true);

    // Re-registering now must NOT see any leftover state (there was none to begin with,
    // but this proves forgetClient's DB DELETE ran even though teardownLiveClient
    // returned false for the not-live case).
    await reg("svc");
    expect(registry.getClient("svc")?.enabled).toBe(true);
  });

  test("purges bundle membership rows referencing a forgotten client's tools (same FK-cascade shape as tool_guards)", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const created = await createBundle("mixed", undefined, [{ client: "svc", tool: "get-users" }], "test");
    expect(created.ok).toBe(true);

    await registry.forgetClient("svc");

    // The bundle itself survives — only the stale membership row is gone.
    const detail = getBundleDetail("mixed");
    expect(detail).toBeDefined();
    expect(detail?.tools).toEqual([]);

    const row = getDb()
      .query(`SELECT 1 FROM mcp_bundle_tools WHERE client_name = ? AND tool_name = ?`)
      .get("svc", "get-users");
    expect(row).toBeNull();
  });
});
