import { describe, test, expect, beforeEach } from "bun:test";

// Registry exports a singleton; import the class by instantiating via the module's
// internal class. Because the class is not exported we exercise it through a fresh
// import that exposes only the singleton — we work around this by directly requiring
// the module and re-casting, or by testing the exported singleton after clearing it.
// The simplest approach: import the singleton and clear it between tests.

import { registry } from "../registry.js";
import type { RestToolDefinition } from "../types.js";

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

function reg(
  name: string,
  tools: RestToolDefinition[] = [makeTool()],
  healthUrl = DEFAULT_HEALTH,
  ip = DEFAULT_IP,
  baseUrl = DEFAULT_BASE,
  resolvedIp = DEFAULT_RESOLVED_IP
) {
  registry.register(name, tools, healthUrl, ip, baseUrl, resolvedIp);
}

// ---------------------------------------------------------------------------
// Clear the singleton registry between every test so tests are isolated.
// ---------------------------------------------------------------------------
beforeEach(() => {
  for (const client of registry.getAllClients()) {
    registry.unregister(client.name);
  }
});

// ---------------------------------------------------------------------------
// Registration — happy path
// ---------------------------------------------------------------------------

describe("Registry.register — valid data", () => {
  test("registers a client successfully", () => {
    reg("my-client");
    expect(registry.getAllClients()).toHaveLength(1);
    expect(registry.getAllClients()[0].name).toBe("my-client");
  });

  test("stores the tool in the tool index", () => {
    reg("svc", [makeTool({ name: "list-items" })]);
    const resolved = registry.resolveTool("svc__list-items");
    expect(resolved).not.toBeUndefined();
    expect(resolved!.tool.name).toBe("list-items");
    expect(resolved!.client.name).toBe("svc");
  });

  test("accepts names starting with a digit", () => {
    reg("1svc");
    expect(registry.getAllClients()[0].name).toBe("1svc");
  });

  test("accepts names with hyphens and underscores", () => {
    reg("my-svc_v2");
    expect(registry.getAllClients()[0].name).toBe("my-svc_v2");
  });
});

// ---------------------------------------------------------------------------
// Registration — invalid client names
// ---------------------------------------------------------------------------

describe("Registry.register — invalid client name", () => {
  test("throws when name is null/undefined-like (empty string)", () => {
    expect(() => reg("")).toThrow("Client name is required");
  });

  test("throws when name contains uppercase letters", () => {
    expect(() => reg("MyClient")).toThrow(/must match/);
  });

  test("throws when name contains special characters", () => {
    expect(() => reg("my client!")).toThrow(/must match/);
  });

  test("throws when name starts with a hyphen", () => {
    expect(() => reg("-bad")).toThrow(/must match/);
  });

  test("throws when name is longer than 63 characters", () => {
    const longName = "a".repeat(64);
    expect(() => reg(longName)).toThrow(/must match/);
  });
});

// ---------------------------------------------------------------------------
// Registration — invalid tool names (Fix 14 — tool name regex)
// ---------------------------------------------------------------------------

describe("Registry.register — invalid tool names", () => {
  test("throws when tool name contains uppercase letters", () => {
    expect(() => reg("svc", [makeTool({ name: "GetUsers" })])).toThrow(
      /name must be lowercase/
    );
  });

  test("throws when tool name contains spaces", () => {
    expect(() => reg("svc", [makeTool({ name: "get users" })])).toThrow(
      /name must be lowercase/
    );
  });

  test("throws when tool name starts with a hyphen", () => {
    expect(() => reg("svc", [makeTool({ name: "-tool" })])).toThrow(
      /name must be lowercase/
    );
  });

  test("throws when tool name exceeds 63 characters", () => {
    expect(() => reg("svc", [makeTool({ name: "t".repeat(64) })])).toThrow(
      /name must be lowercase/
    );
  });
});

// ---------------------------------------------------------------------------
// Registration — inputSchema size limit (Fix 6 — 10 KB cap)
// ---------------------------------------------------------------------------

describe("Registry.register — inputSchema size limit", () => {
  test("throws when inputSchema exceeds 10 KB", () => {
    const hugeSchema: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(11_000),
    };
    expect(() => reg("svc", [makeTool({ inputSchema: hugeSchema })])).toThrow(
      /exceeds 10KB/
    );
  });

  test("accepts inputSchema exactly at the limit boundary (9 KB)", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(9_000),
    };
    // Should not throw — 9 KB is under the 10 KB limit
    expect(() => reg("svc", [makeTool({ inputSchema: schema })])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Registration — duplicate tool names
// ---------------------------------------------------------------------------

describe("Registry.register — duplicate tool names", () => {
  test("throws when the same tool name appears twice in the tools array", () => {
    const tools = [makeTool({ name: "do-thing" }), makeTool({ name: "do-thing" })];
    expect(() => reg("svc", tools)).toThrow(/Duplicate tool name/);
  });
});

// ---------------------------------------------------------------------------
// Tool index — key format `clientName__toolName`
// ---------------------------------------------------------------------------

describe("Registry.resolveTool — tool index key format", () => {
  test("resolves via double-underscore composite key", () => {
    reg("payments", [makeTool({ name: "charge-card" })]);
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
  test("overwrites old client data on re-registration", () => {
    reg("svc", [makeTool({ name: "old-tool" })]);
    reg("svc", [makeTool({ name: "new-tool" })]);

    // Only one client
    expect(registry.getAllClients()).toHaveLength(1);

    // New tool is present
    expect(registry.resolveTool("svc__new-tool")).not.toBeUndefined();
  });

  test("removes old tool index entries on re-registration", () => {
    reg("svc", [makeTool({ name: "old-tool" })]);
    reg("svc", [makeTool({ name: "new-tool" })]);

    // Old tool index entry must be gone
    expect(registry.resolveTool("svc__old-tool")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unregister
// ---------------------------------------------------------------------------

describe("Registry.unregister", () => {
  test("removes the client", () => {
    reg("svc");
    registry.unregister("svc");
    expect(registry.getAllClients()).toHaveLength(0);
  });

  test("removes the client's tool index entries", () => {
    reg("svc", [makeTool({ name: "my-tool" })]);
    registry.unregister("svc");
    expect(registry.resolveTool("svc__my-tool")).toBeUndefined();
  });

  test("returns true when client existed", () => {
    reg("svc");
    expect(registry.unregister("svc")).toBe(true);
  });

  test("returns false when client did not exist", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });
});
