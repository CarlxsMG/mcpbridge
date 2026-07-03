/**
 * Tool tagging: normalize/dedupe, listings, registry integration, cascade.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { setToolTags, getToolTags, listAllTags, listToolsByTag } from "../tool-tags.js";
import type { RestToolDefinition } from "../types.js";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("tool tags", () => {
  test("set/get normalizes case and dedupes", async () => {
    await reg("svc", [makeTool("t")]);
    expect(setToolTags("svc", "t", ["Billing", "billing", "READ"])).toBe(true);
    expect(getToolTags("svc", "t")).toEqual(["billing", "read"]);
  });

  test("invalid tags are dropped", async () => {
    await reg("svc", [makeTool("t")]);
    setToolTags("svc", "t", ["ok", "has space", "bad!"]);
    expect(getToolTags("svc", "t")).toEqual(["ok"]);
  });

  test("returns false for an unknown tool", async () => {
    await reg("svc", [makeTool("t")]);
    expect(setToolTags("svc", "nope", ["x"])).toBe(false);
  });

  test("listAllTags counts tools per tag", async () => {
    await reg("svc", [makeTool("a"), makeTool("b")]);
    setToolTags("svc", "a", ["x", "y"]);
    setToolTags("svc", "b", ["x"]);
    const tags = listAllTags();
    expect(tags.find((t) => t.tag === "x")?.count).toBe(2);
    expect(tags.find((t) => t.tag === "y")?.count).toBe(1);
  });

  test("listToolsByTag returns matching tools", async () => {
    await reg("svc", [makeTool("a"), makeTool("b")]);
    setToolTags("svc", "a", ["x"]);
    expect(listToolsByTag("x")).toEqual([{ client: "svc", tool: "a" }]);
  });

  test("getClientDetail includes fresh tags", async () => {
    await reg("svc", [makeTool("a")]);
    setToolTags("svc", "a", ["x"]);
    expect(registry.getClientDetail("svc")!.tools[0].tags).toEqual(["x"]);
  });

  test("listAllTools includes tags", async () => {
    await reg("svc", [makeTool("a")]);
    setToolTags("svc", "a", ["x"]);
    expect(registry.listAllTools().find((r) => r.tool === "a")?.tags).toEqual(["x"]);
  });

  test("tags cascade-delete when the client is forgotten", async () => {
    await reg("svc", [makeTool("a")]);
    setToolTags("svc", "a", ["x"]);
    await registry.forgetClient("svc");
    expect(listAllTags()).toHaveLength(0);
  });
});
