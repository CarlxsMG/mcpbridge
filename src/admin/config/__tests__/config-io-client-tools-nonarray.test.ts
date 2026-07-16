/**
 * Finding #19: the clients import loop must not throw when a client's `tools`
 * field is a truthy non-array (e.g. `{}`) — it should skip-report, matching the
 * bundles loop's fail-soft contract, rather than crashing a non-transactional
 * import mid-way.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { importConfig } from "../config-io.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(name = "get-users"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("client tools non-array guard (#19)", () => {
  test("a client whose tools field isn't an array reports a skip instead of throwing", async () => {
    await reg("svc");
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [{ name: "svc", enabled: true, guards: null, tools: {} }],
      guardrails: [],
      consumers: [],
    };

    const result = await importConfig(doc, { dryRun: false }, "t");
    // Client-level config still applied; the malformed tools list is reported.
    expect(result.applied.clientsConfigured).toBe(1);
    expect(result.applied.toolsConfigured).toBe(0);
    const skip = result.skipped.find((s) => s.type === "client" && s.id === "svc");
    expect(skip?.reason).toBe("tools field is not an array");
  });

  test("does not abort a subsequent well-formed client in the same import", async () => {
    await reg("svca");
    await reg("svcb");
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [
        { name: "svca", enabled: true, guards: null, tools: "nope" },
        {
          name: "svcb",
          enabled: true,
          guards: null,
          tools: [{ name: "get-users", enabled: true, guards: null, override: null }],
        },
      ],
      guardrails: [],
      consumers: [],
    };

    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.skipped.some((s) => s.type === "client" && s.id === "svca")).toBe(true);
    // The following well-formed client's tool was still configured.
    expect(result.applied.toolsConfigured).toBe(1);
  });
});
