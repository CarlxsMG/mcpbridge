/**
 * Stryker mutation-testing backstop for src/tool-meta/tool-mock.ts.
 * Baseline 95.65% (22/23) — the existing mock.test.ts (config persistence +
 * proxy integration) fully covers this file except one gap: every existing
 * test only ever persists `enabled: true`, so `row.enabled === 1` being
 * forced always-true was never observed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { getToolMock, setToolMock } from "../../tool-meta/tool-mock.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const TOOL = "get-x";
function makeTool(): RestToolDefinition {
  return {
    name: TOOL,
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register(CLIENT, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

// 36:21-36:38 ConditionalExpression [Survived] true (`row.enabled === 1`
// forced true). Every existing test only ever persists `enabled: true`.
describe("getToolMock — a config persisted with enabled:false reads back false", () => {
  test("enabled:false is not forced to true on read", async () => {
    await reg();
    setToolMock(CLIENT, TOOL, { enabled: false, mode: "always", response: "{}" });
    expect(getToolMock(CLIENT, TOOL)?.enabled).toBe(false);
  });
});
