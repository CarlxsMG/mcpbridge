import { describe, test, expect } from "bun:test";
import { RegistryAliasIndex } from "../mcp/registry-alias-index.js";
import { TOOL_KEY_SEPARATOR } from "../lib/identifier.js";
import type { RegisteredTool } from "../mcp/types.js";

const TOOL: RegisteredTool = {
  name: "get-foo",
  method: "GET",
  endpoint: "/foo",
  description: "Get foo",
  inputSchema: { type: "object", properties: {} },
  enabled: true,
};

function makeTool(name: string, displayName?: string): RegisteredTool {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: `Get ${name}`,
    inputSchema: { type: "object", properties: {} },
    enabled: true,
    ...(displayName
      ? { override: { displayName, params: undefined, description: undefined, driftNote: undefined } }
      : {}),
  };
}

describe("RegistryAliasIndex — resolve", () => {
  test("non-alias name resolves to itself", () => {
    const i = new RegistryAliasIndex();
    expect(i.resolve("client__tool")).toBe("client__tool");
  });

  test("setAlias + resolve: alias maps back to canonical", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("client", "tool", "alias");
    expect(i.resolve(`client${TOOL_KEY_SEPARATOR}alias`)).toBe(`client${TOOL_KEY_SEPARATOR}tool`);
  });

  test("displayName === toolName is treated as no-op (no self-alias)", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("client", "tool", "tool");
    expect(i.resolve("client__tool")).toBe("client__tool");
    expect(i.size()).toBe(0);
  });
});

describe("RegistryAliasIndex — rebuildForClient", () => {
  test("replaces prior aliases for that client only", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("acme", "old", "old-alias");
    i.rebuildForClient(
      "acme",
      [makeTool("new1"), makeTool("new2", "new-alias")],
    );
    // Old alias gone
    expect(i.size()).toBe(1);
    expect(i.resolve(`acme${TOOL_KEY_SEPARATOR}old-alias`)).toBe(`acme${TOOL_KEY_SEPARATOR}old-alias`);
    // New alias present
    expect(i.resolve(`acme${TOOL_KEY_SEPARATOR}new-alias`)).toBe(`acme${TOOL_KEY_SEPARATOR}new2`);
  });

  test("does NOT touch aliases for other clients", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("acme", "tool", "acme-alias");
    i.setAlias("other", "tool", "other-alias");
    i.rebuildForClient("acme", [makeTool("fresh")]);
    expect(i.resolve(`other${TOOL_KEY_SEPARATOR}other-alias`)).toBe(`other${TOOL_KEY_SEPARATOR}tool`);
    expect(i.resolve(`acme${TOOL_KEY_SEPARATOR}acme-alias`)).toBe(`acme${TOOL_KEY_SEPARATOR}acme-alias`);
  });

  test("tools without overrides produce no aliases", () => {
    const i = new RegistryAliasIndex();
    i.rebuildForClient("acme", [makeTool("a"), makeTool("b")]);
    expect(i.size()).toBe(0);
  });
});

describe("RegistryAliasIndex — clearForClient", () => {
  test("removes only entries with the matching clientName__ prefix", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("acme", "tool", "alias");
    i.setAlias("acme-evil", "tool", "alias"); // cross-client prefix ambiguity guard
    i.clearForClient("acme");
    expect(i.resolve(`acme${TOOL_KEY_SEPARATOR}alias`)).toBe(`acme${TOOL_KEY_SEPARATOR}alias`);
    expect(i.resolve(`acme-evil${TOOL_KEY_SEPARATOR}alias`)).toBe(`acme-evil${TOOL_KEY_SEPARATOR}tool`);
  });
});

describe("RegistryAliasIndex — setAlias replaces prior alias for the same tool", () => {
  test("rename: old alias → new alias without leaving the old one behind", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("c", "tool", "old-alias");
    i.setAlias("c", "tool", "new-alias");
    expect(i.size()).toBe(1);
    expect(i.resolve(`c${TOOL_KEY_SEPARATOR}old-alias`)).toBe(`c${TOOL_KEY_SEPARATOR}old-alias`);
    expect(i.resolve(`c${TOOL_KEY_SEPARATOR}new-alias`)).toBe(`c${TOOL_KEY_SEPARATOR}tool`);
  });
});

describe("RegistryAliasIndex — clearAll + size diagnostics", () => {
  test("clearAll removes everything", () => {
    const i = new RegistryAliasIndex();
    i.setAlias("a", "x", "ax");
    i.setAlias("b", "y", "by");
    expect(i.size()).toBe(2);
    i.clearAll();
    expect(i.size()).toBe(0);
  });
});

describe("RegistryAliasIndex — prefix isolation", () => {
  test("alias from client 'acme' never resolves under client 'acme-evil' even if both share a toolname", () => {
    // Documents the cross-client guard: prefixes use `__` as boundary, so
    // `acme__alias` and `acme-evil__alias` are completely separate keys.
    const i = new RegistryAliasIndex();
    i.setAlias("acme", "read", "r");
    i.setAlias("acme-evil", "read", "r");
    expect(i.resolve("acme__r")).toBe("acme__read");
    expect(i.resolve("acme-evil__r")).toBe("acme-evil__read");
  });
});

// Keep the makeTool helper "used" so it doesn't get the lint-unused-var warning
// on someone reordering this file.
expect(makeTool("x").name).toBe("x");
expect(TOOL.name).toBe("get-foo");
