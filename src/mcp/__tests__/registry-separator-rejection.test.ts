/**
 * Regression for Finding #14: TOOL_NAME_RE permits interior/consecutive
 * underscores and TOOL_KEY_SEPARATOR is "__", so without an explicit guard two
 * distinct (client, tool) pairs could collide on the `clientName__toolName`
 * composite key — letting one client shadow / tear down another's tool.
 * validateClientName and validateToolIdentity now reject the "__" separator in
 * either segment (mirroring composites.ts's isValidCompositeName).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
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

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
});

describe("Registry.register — rejects the '__' composite-key separator", () => {
  test("rejects a client name containing '__'", async () => {
    await expect(reg("my__client")).rejects.toThrow(/must not contain '__'/);
  });

  test("rejects a tool name containing '__'", async () => {
    await expect(reg("svc", [makeTool({ name: "get__users" })])).rejects.toThrow(/must not contain '__'/);
  });

  test("still accepts a single interior underscore in both segments", async () => {
    await reg("my_client", [makeTool({ name: "get_users" })]);
    expect(registry.getClient("my_client")).toBeDefined();
  });
});
