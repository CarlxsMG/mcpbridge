import { describe, test, expect, beforeEach, it } from "bun:test";

// Registry exports a singleton; import the class by instantiating via the module's
// internal class. Because the class is not exported we exercise it through a fresh
// import that exposes only the singleton — we work around this by directly requiring
// the module and re-casting, or by testing the exported singleton after clearing it.
// The simplest approach: import the singleton and clear it between tests.

import { registry, validateEndpointPath } from "../mcp/registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import type { RestToolDefinition } from "../mcp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const DEFAULT_HEALTH = "http://example.com/health";
const DEFAULT_BASE = "http://example.com";
const DEFAULT_IP = "1.2.3.4";
const DEFAULT_RESOLVED_IP = "1.2.3.4";

async function reg(
  name: string,
  tools: RestToolDefinition[] = [makeTool()],
  healthUrl = DEFAULT_HEALTH,
  ip = DEFAULT_IP,
  baseUrl = DEFAULT_BASE,
  resolvedIp = DEFAULT_RESOLVED_IP,
) {
  await registry.register(name, tools, healthUrl, ip, baseUrl, resolvedIp);
}

// ---------------------------------------------------------------------------
// Clear the singleton registry between every test so tests are isolated.
// ---------------------------------------------------------------------------
beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  // Fresh in-memory SQLite per test — unregister() deliberately doesn't purge
  // persisted enabled/guards state, so a shared DB would leak it across tests
  // that reuse generic client names like "svc".
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// Registration — happy path
// ---------------------------------------------------------------------------

describe("Registry.register — valid data", () => {
  test("registers a client successfully", async () => {
    await reg("my-client");
    expect(registry.listClients()).toHaveLength(1);
    expect(registry.listClients()[0].name).toBe("my-client");
  });

  test("stores the tool in the tool index", async () => {
    await reg("svc", [makeTool({ name: "list-items" })]);
    const resolved = registry.resolveTool("svc__list-items");
    expect(resolved).not.toBeUndefined();
    expect(resolved!.tool.name).toBe("list-items");
    expect(resolved!.client.name).toBe("svc");
  });

  test("accepts names starting with a digit", async () => {
    await reg("1svc");
    expect(registry.listClients()[0].name).toBe("1svc");
  });

  test("accepts names with hyphens and underscores", async () => {
    await reg("my-svc_v2");
    expect(registry.listClients()[0].name).toBe("my-svc_v2");
  });
});

// ---------------------------------------------------------------------------
// Registration — invalid client names
// ---------------------------------------------------------------------------

describe("Registry.register — invalid client name", () => {
  test("throws when name is null/undefined-like (empty string)", async () => {
    await expect(reg("")).rejects.toThrow("Client name is required");
  });

  test("throws when name contains uppercase letters", async () => {
    await expect(reg("MyClient")).rejects.toThrow(/must match/);
  });

  test("throws when name contains special characters", async () => {
    await expect(reg("my client!")).rejects.toThrow(/must match/);
  });

  test("throws when name starts with a hyphen", async () => {
    await expect(reg("-bad")).rejects.toThrow(/must match/);
  });

  test("throws when name is longer than 63 characters", async () => {
    const longName = "a".repeat(64);
    await expect(reg(longName)).rejects.toThrow(/must match/);
  });
});

// ---------------------------------------------------------------------------
// Registration — invalid tool names (Fix 14 — tool name regex)
// ---------------------------------------------------------------------------

describe("Registry.register — invalid tool names", () => {
  test("throws when tool name contains uppercase letters", async () => {
    await expect(reg("svc", [makeTool({ name: "GetUsers" })])).rejects.toThrow(/name must be lowercase/);
  });

  test("throws when tool name contains spaces", async () => {
    await expect(reg("svc", [makeTool({ name: "get users" })])).rejects.toThrow(/name must be lowercase/);
  });

  test("throws when tool name starts with a hyphen", async () => {
    await expect(reg("svc", [makeTool({ name: "-tool" })])).rejects.toThrow(/name must be lowercase/);
  });

  test("throws when tool name exceeds 63 characters", async () => {
    await expect(reg("svc", [makeTool({ name: "t".repeat(64) })])).rejects.toThrow(/name must be lowercase/);
  });
});

// ---------------------------------------------------------------------------
// Registration — inputSchema size limit (Fix 6 — 10 KB cap)
// ---------------------------------------------------------------------------

describe("Registry.register — inputSchema size limit", () => {
  test("throws when inputSchema exceeds 10 KB", async () => {
    const hugeSchema: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(11_000),
    };
    await expect(reg("svc", [makeTool({ inputSchema: hugeSchema })])).rejects.toThrow(/exceeds 10KB/);
  });

  test("accepts inputSchema exactly at the limit boundary (9 KB)", async () => {
    const schema: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(9_000),
    };
    // Should not throw — 9 KB is under the 10 KB limit
    await expect(reg("svc", [makeTool({ inputSchema: schema })])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registration — duplicate tool names
// ---------------------------------------------------------------------------

describe("Registry.register — duplicate tool names", () => {
  test("throws when the same tool name appears twice in the tools array", async () => {
    const tools = [makeTool({ name: "do-thing" }), makeTool({ name: "do-thing" })];
    await expect(reg("svc", tools)).rejects.toThrow(/Duplicate tool name/);
  });
});

// ---------------------------------------------------------------------------
// Tool index — key format `clientName__toolName`
// ---------------------------------------------------------------------------

describe("Registry.resolveTool — tool index key format", () => {
  test("resolves via double-underscore composite key", async () => {
    await reg("payments", [makeTool({ name: "charge-card" })]);
    const resolved = registry.resolveTool("payments__charge-card");
    expect(resolved?.client.name).toBe("payments");
    expect(resolved?.tool.name).toBe("charge-card");
  });

  test("returns undefined for unknown key", () => {
    expect(registry.resolveTool("nobody__nothing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Re-registration — overwrites previous entry
// ---------------------------------------------------------------------------

describe("Registry.register — re-registration", () => {
  test("overwrites old client data on re-registration", async () => {
    await reg("svc", [makeTool({ name: "old-tool" })]);
    await reg("svc", [makeTool({ name: "new-tool" })]);

    // Only one client
    expect(registry.listClients()).toHaveLength(1);

    // New tool is present
    expect(registry.resolveTool("svc__new-tool")).not.toBeUndefined();
  });

  test("removes old tool index entries on re-registration", async () => {
    await reg("svc", [makeTool({ name: "old-tool" })]);
    await reg("svc", [makeTool({ name: "new-tool" })]);

    // Old tool index entry must be gone
    expect(registry.resolveTool("svc__old-tool")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unregister
// ---------------------------------------------------------------------------

describe("Registry.unregister", () => {
  test("removes the client", async () => {
    await reg("svc");
    await registry.unregister("svc");
    expect(registry.listClients()).toHaveLength(0);
  });

  test("removes the client's tool index entries", async () => {
    await reg("svc", [makeTool({ name: "my-tool" })]);
    await registry.unregister("svc");
    expect(registry.resolveTool("svc__my-tool")).toBeUndefined();
  });

  test("returns true when client existed", async () => {
    await reg("svc");
    expect(await registry.unregister("svc")).toBe(true);
  });

  test("returns false when client did not exist", async () => {
    expect(await registry.unregister("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutex — concurrent register calls do not leave orphaned toolIndex entries
// ---------------------------------------------------------------------------

describe("Registry.register — mutex prevents interleaved concurrent registrations", () => {
  test("two concurrent registers for the same name produce a consistent toolIndex", async () => {
    const tools1 = [makeTool({ name: "tool-one" }), makeTool({ name: "tool-two" })];
    const tools2 = [makeTool({ name: "tool-alpha" })];

    // Fire both concurrently — the mutex must serialise them.
    await Promise.all([
      registry.register("svc", tools1, DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP),
      registry.register("svc", tools2, DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP),
    ]);

    // Exactly one client registered
    expect(registry.listClients()).toHaveLength(1);

    const client = registry.getClient("svc");
    expect(client).toBeDefined();

    // toolIndex must exactly match what the winner registered — no phantom entries
    const registeredToolNames = client!.tools.map((t) => t.name);
    for (const name of registeredToolNames) {
      expect(registry.resolveTool(`svc__${name}`)).toBeDefined();
    }

    // The loser's tools must NOT appear in the index
    const allKeys = ["tool-one", "tool-two", "tool-alpha"];
    const presentKeys = allKeys.filter((k) => registry.resolveTool(`svc__${k}`) !== undefined);
    // Present keys must match the winner's registered tools exactly
    expect(presentKeys.sort()).toEqual(registeredToolNames.sort());
  });
});

// ---------------------------------------------------------------------------
// Unregister — cleanup ordering (abort → removeBreaker → clients.delete)
// ---------------------------------------------------------------------------

describe("Registry.unregister — cleanup regression", () => {
  test("getClient returns undefined and toolIndex is clean after unregister", async () => {
    await registry.register(
      "bye-svc",
      [makeTool({ name: "bye-tool" })],
      DEFAULT_HEALTH,
      DEFAULT_IP,
      DEFAULT_BASE,
      DEFAULT_RESOLVED_IP,
    );
    await registry.unregister("bye-svc");

    expect(registry.getClient("bye-svc")).toBeUndefined();
    expect(registry.resolveTool("bye-svc__bye-tool")).toBeUndefined();
  });

  test("circuit breaker is removed after unregister (no stale open state)", async () => {
    const { getCircuitBreaker, removeCircuitBreaker: removeCB } = await import("../circuit-breaker.js");

    await registry.register("cb-svc", [makeTool()], DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP);
    // Trip the breaker before unregistering
    const cb = getCircuitBreaker("cb-svc");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    await registry.unregister("cb-svc");

    // After unregister, getting the breaker again must yield a fresh closed instance.
    // If removeCircuitBreaker was NOT called, the old open breaker would still be in the map.
    const fresh = getCircuitBreaker("cb-svc");
    expect(fresh.getState()).toBe("closed");

    // Clean up
    removeCB("cb-svc");
  });

  test("multiple tools all removed from toolIndex after unregister", async () => {
    await registry.register(
      "multi-svc",
      [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" }), makeTool({ name: "tool-c" })],
      DEFAULT_HEALTH,
      DEFAULT_IP,
      DEFAULT_BASE,
      DEFAULT_RESOLVED_IP,
    );
    await registry.unregister("multi-svc");

    expect(registry.resolveTool("multi-svc__tool-a")).toBeUndefined();
    expect(registry.resolveTool("multi-svc__tool-b")).toBeUndefined();
    expect(registry.resolveTool("multi-svc__tool-c")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registration — endpoint path-traversal validation (Sprint 3 Fix 2)
// ---------------------------------------------------------------------------

// validateEndpointPath unit tests — checks the exported validation helper directly.
describe("validateEndpointPath — path-traversal segment detection", () => {
  test("returns an error string for endpoint with '..' segment after param substitution", () => {
    expect(validateEndpointPath("/users/:id/../admin")).not.toBeNull();
  });

  test("returns null for a clean parameterised endpoint", () => {
    expect(validateEndpointPath("/users/:id")).toBeNull();
  });

  test("returns null for endpoint with a dot-prefixed segment that is not traversal", () => {
    // '.config' is a valid resource name — not a traversal segment
    expect(validateEndpointPath("/users/.config")).toBeNull();
  });

  test("returns an error string for endpoint with a single-dot '.' segment", () => {
    expect(validateEndpointPath("/users/./profile")).not.toBeNull();
  });
});

// Registration integration: registry.register() delegates to validateEndpointPath
// and throws for invalid endpoint templates.
describe("Registry.register — endpoint path-traversal validation (integration)", () => {
  test("throws when endpoint contains '..' segment", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/:id/../admin" })])).rejects.toThrow(/invalid path segment/i);
  });

  test("succeeds for a clean parameterised endpoint", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/:id" })])).resolves.toBeUndefined();
  });

  test("succeeds for endpoint with a dot-prefixed segment that is not traversal", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/.config" })])).resolves.toBeUndefined();
  });

  test("throws when endpoint contains a single-dot '.' segment", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/./profile" })])).rejects.toThrow(/invalid path segment/i);
  });
});

// ---------------------------------------------------------------------------
// AUTH_DISABLED production guard — covered in src/__tests__/startup-guards.test.ts
// ---------------------------------------------------------------------------
