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

describe("Registry.register — default enabled state", () => {
  test("a brand-new client defaults to enabled: true", async () => {
    await reg("svc");
    expect(registry.getClient("svc")?.enabled).toBe(true);
  });

  test("a brand-new tool defaults to enabled: true", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(registry.resolveTool("svc__get-users")?.tool.enabled).toBe(true);
  });
});

describe("Registry.setClientEnabled", () => {
  test("returns false for an unknown client", async () => {
    expect(await registry.setClientEnabled("nobody", false)).toBe(false);
  });

  test("disables a live client and excludes it from getAllMcpTools", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(registry.getAllMcpTools().some((t) => t.name === "svc__get-users")).toBe(true);

    expect(await registry.setClientEnabled("svc", false)).toBe(true);

    expect(registry.getClient("svc")?.enabled).toBe(false);
    expect(registry.getAllMcpTools().some((t) => t.name === "svc__get-users")).toBe(false);
  });

  test("re-enabling restores visibility in getAllMcpTools", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("svc", false);
    await registry.setClientEnabled("svc", true);

    expect(registry.getAllMcpTools().some((t) => t.name === "svc__get-users")).toBe(true);
  });
});

describe("Registry.setToolEnabled", () => {
  test("returns false for an unknown client or tool", async () => {
    expect(await registry.setToolEnabled("nobody", "nothing", false)).toBe(false);
    await reg("svc");
    expect(await registry.setToolEnabled("svc", "nonexistent-tool", false)).toBe(false);
  });

  test("disabling one tool leaves sibling tools servable", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await registry.setToolEnabled("svc", "tool-a", false);

    const names = registry.getAllMcpTools().map((t) => t.name);
    expect(names).not.toContain("svc__tool-a");
    expect(names).toContain("svc__tool-b");
  });
});

describe("Registry.getMcpToolsForClient — sharded listing", () => {
  test("returns [] for an unknown client", () => {
    expect(registry.getMcpToolsForClient("nobody")).toEqual([]);
  });

  test("returns [] for a disabled client even though it has enabled tools", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("svc", false);
    expect(registry.getMcpToolsForClient("svc")).toEqual([]);
  });

  test("excludes only the disabled tools within an enabled client", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await registry.setToolEnabled("svc", "tool-a", false);

    const names = registry.getMcpToolsForClient("svc").map((t) => t.name);
    expect(names).toEqual(["svc__tool-b"]);
  });

  test("never includes another client's tools", async () => {
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await reg("client-b", [makeTool({ name: "tool-b" })]);

    const names = registry.getMcpToolsForClient("client-a").map((t) => t.name);
    expect(names).toEqual(["client-a__tool-a"]);
  });
});

describe("enabled: false backstop in proxyToolCall", () => {
  const originalFetch = globalThis.fetch;

  test("a disabled tool is rejected even when called directly with a stale/cached name", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolEnabled("svc", "get-users", false);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { proxyToolCall } = await import("../proxy/proxy.js");
    const result = await proxyToolCall("svc__get-users", {});

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/i);
    expect(fetchCalled).toBe(false);
  });

  test("a disabled client rejects calls to its (still-enabled) tools", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setClientEnabled("svc", false);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { proxyToolCall } = await import("../proxy/proxy.js");
    const result = await proxyToolCall("svc__get-users", {});

    globalThis.fetch = originalFetch;

    expect(result.isError).toBe(true);
    expect(fetchCalled).toBe(false);
  });
});
