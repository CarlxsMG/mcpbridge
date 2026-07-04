/**
 * Tests for registry.ts unregister race protection and cleanup ordering.
 *
 * Note: The linter removed isDeleting/deletingClients from registry.ts and the
 * corresponding guard from proxy.ts. These tests cover what is actually present:
 * - unregister clears toolIndex atomically (mutex-protected)
 * - re-registering the same name after delete works cleanly
 * - concurrent register + unregister leaves a consistent toolIndex (mutex)
 * - proxyToolCall returns isError for an unknown tool (client already removed)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../mcp/registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import type { RestToolDefinition } from "../mcp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "do-thing",
    method: "GET",
    endpoint: "/thing",
    description: "does a thing",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string) {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// TEST 1: getClient returns undefined before registration
// ---------------------------------------------------------------------------

describe("registry — getClient before register", () => {
  test("getClient returns undefined for a name that was never registered", () => {
    expect(registry.getClient("nobody")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TEST 2: getClient returns undefined after unregister
// ---------------------------------------------------------------------------

describe("registry — getClient after unregister", () => {
  test("getClient returns undefined once unregister has finished", async () => {
    await reg("delete-svc");
    await registry.unregister("delete-svc");
    expect(registry.getClient("delete-svc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Re-registration after delete works cleanly
// ---------------------------------------------------------------------------

describe("registry — re-register after unregister", () => {
  test("registering the same name immediately after delete succeeds", async () => {
    await reg("reuse-svc");
    await registry.unregister("reuse-svc");
    await expect(reg("reuse-svc")).resolves.toBeUndefined();
    expect(registry.getClient("reuse-svc")).toBeDefined();
  });

  test("toolIndex is clean after delete-then-re-register", async () => {
    await registry.register(
      "reuse2-svc",
      [makeTool({ name: "old-tool" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    await registry.unregister("reuse2-svc");

    await registry.register(
      "reuse2-svc",
      [makeTool({ name: "new-tool" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );

    // Old tool must be gone; new tool must be present
    expect(registry.resolveTool("reuse2-svc__old-tool")).toBeUndefined();
    expect(registry.resolveTool("reuse2-svc__new-tool")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TEST 4: proxyToolCall returns isError for unknown tool after client unregistered
// ---------------------------------------------------------------------------

describe("proxyToolCall — unknown tool after client unregistered", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("proxyToolCall returns isError with 'Unknown tool' when client was removed", async () => {
    await reg("guard-svc");
    await registry.unregister("guard-svc");

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { proxyToolCall } = await import("../proxy.js");
    const result = await proxyToolCall("guard-svc__do-thing", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown tool/i);
    // fetch must NOT have been called
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST 5: Concurrent register + unregister — mutex prevents orphan toolIndex entries
// ---------------------------------------------------------------------------

describe("registry — concurrent delete and re-register via mutex", () => {
  test("concurrent unregister + register leaves a consistent toolIndex", async () => {
    await reg("concurrent-svc");

    // Fire both concurrently — the mutex must serialise them
    await Promise.all([registry.unregister("concurrent-svc"), reg("concurrent-svc")]);

    // Exactly one operation must have won — toolIndex must be internally consistent
    const client = registry.getClient("concurrent-svc");
    if (client) {
      // If client exists, its tools must be in the index
      for (const tool of client.tools) {
        expect(registry.resolveTool(`concurrent-svc__${tool.name}`)).toBeDefined();
      }
    } else {
      // If client doesn't exist, no stale tool entries should remain
      expect(registry.resolveTool("concurrent-svc__do-thing")).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 6: resolveTool returns undefined for removed client's tools
// ---------------------------------------------------------------------------

describe("registry.resolveTool — after unregister", () => {
  test("resolveTool returns undefined for all tools after client unregistered", async () => {
    await registry.register(
      "multi-svc",
      [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
    await registry.unregister("multi-svc");

    expect(registry.resolveTool("multi-svc__tool-a")).toBeUndefined();
    expect(registry.resolveTool("multi-svc__tool-b")).toBeUndefined();
  });
});
