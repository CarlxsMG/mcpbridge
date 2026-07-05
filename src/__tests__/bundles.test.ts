import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../mcp/registry.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import {
  initBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  listBundles,
  getBundleDetail,
  isBundleEnabled,
  getBundleToolKeys,
} from "../admin/tool-composition/bundles.js";
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
  initBundles();
});

describe("createBundle", () => {
  test("creates a bundle spanning multiple clients and populates the hot-path cache", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await reg("slack", [makeTool({ name: "post-message" })]);

    const result = await createBundle(
      "assistant-a",
      "for assistant A",
      [
        { client: "github", tool: "list-issues" },
        { client: "slack", tool: "post-message" },
      ],
      "test-actor",
    );

    expect(result.ok).toBe(true);
    expect(isBundleEnabled("assistant-a")).toBe(true);
    expect(getBundleToolKeys("assistant-a")).toEqual(new Set(["github__list-issues", "slack__post-message"]));
  });

  test("rejects an invalid name", async () => {
    const result = await createBundle("Not Valid!", undefined, [], "test-actor");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_NAME");
  });

  test("rejects a duplicate name", async () => {
    await createBundle("dupe", undefined, [], "test-actor");
    const result = await createBundle("dupe", undefined, [], "test-actor");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ALREADY_EXISTS");
  });

  test("rejects a tool pair that doesn't exist", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    const result = await createBundle("bad", undefined, [{ client: "github", tool: "nonexistent" }], "test-actor");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TOOL");
    expect(getBundleDetail("bad")).toBeUndefined();
  });

  test("dedupes repeated (client, tool) pairs in the same payload", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    const result = await createBundle(
      "dedup",
      undefined,
      [
        { client: "github", tool: "list-issues" },
        { client: "github", tool: "list-issues" },
      ],
      "test-actor",
    );
    expect(result.ok).toBe(true);
    expect(getBundleDetail("dedup")?.tools).toEqual([{ client: "github", tool: "list-issues" }]);
  });

  test("allows an empty tool list, consistent with client registration allowing zero tools", async () => {
    const result = await createBundle("empty", undefined, [], "test-actor");
    expect(result.ok).toBe(true);
    expect(getBundleToolKeys("empty")).toEqual(new Set());
  });
});

describe("updateBundle", () => {
  test("returns NOT_FOUND for an unknown bundle", async () => {
    const result = await updateBundle("nope", { enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("toggling enabled updates the hot-path cache and leaves tool membership untouched", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");

    const result = await updateBundle("b", { enabled: false });
    expect(result.ok).toBe(true);
    expect(isBundleEnabled("b")).toBe(false);
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"])); // existence independent of enabled
  });

  test("replacing the tools list fully replaces membership (old members not in the new list are dropped)", async () => {
    await reg("github", [makeTool({ name: "list-issues" }), makeTool({ name: "create-issue" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");

    const result = await updateBundle("b", { tools: [{ client: "github", tool: "create-issue" }] });
    expect(result.ok).toBe(true);
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__create-issue"]));
  });

  test("rejects an unknown tool pair in a tools-list replacement without mutating existing membership", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");

    const result = await updateBundle("b", { tools: [{ client: "github", tool: "does-not-exist" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TOOL");
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"]));
  });

  test("description-only update does not touch tool membership", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", "v1", [{ client: "github", tool: "list-issues" }], "test-actor");

    await updateBundle("b", { description: "v2" });
    expect(getBundleDetail("b")?.description).toBe("v2");
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"]));
  });
});

describe("deleteBundle", () => {
  test("returns false for an unknown bundle", async () => {
    expect(await deleteBundle("nope")).toBe(false);
  });

  test("removes the bundle from SQLite and the hot-path cache", async () => {
    await createBundle("gone", undefined, [], "test-actor");
    expect(await deleteBundle("gone")).toBe(true);
    expect(getBundleDetail("gone")).toBeUndefined();
    expect(getBundleToolKeys("gone")).toBeUndefined();
  });
});

describe("listBundles / getBundleDetail", () => {
  test("listBundles reports tool counts", async () => {
    await reg("github", [makeTool({ name: "list-issues" }), makeTool({ name: "create-issue" })]);
    await createBundle(
      "b",
      "desc",
      [
        { client: "github", tool: "list-issues" },
        { client: "github", tool: "create-issue" },
      ],
      "test-actor",
    );

    const summary = listBundles().find((b) => b.name === "b");
    expect(summary).toEqual({ name: "b", description: "desc", enabled: true, toolsCount: 2 });
  });
});

describe("cascade on tool removal", () => {
  test("re-registering a client without a previously-included tool cascades the SQL membership row", async () => {
    await reg("github", [makeTool({ name: "list-issues" }), makeTool({ name: "create-issue" })]);
    await createBundle(
      "b",
      undefined,
      [
        { client: "github", tool: "list-issues" },
        { client: "github", tool: "create-issue" },
      ],
      "test-actor",
    );

    // Full-replace registration without "create-issue" — registry.ts deletes the stale tool row,
    // which cascades to mcp_bundle_tools via the composite FK.
    await reg("github", [makeTool({ name: "list-issues" })]);

    const row = getDb()
      .query(`SELECT 1 FROM mcp_bundle_tools WHERE bundle_name = ? AND client_name = ? AND tool_name = ?`)
      .get("b", "github", "create-issue");
    expect(row).toBeNull();

    // Live resolution stays correct even though the in-memory toolKeys cache
    // may still hold the phantom key — getMcpToolsForKeys always intersects
    // with the client's live (current) tool list.
    expect(registry.getMcpToolsForKeys(getBundleToolKeys("b")!).map((t) => t.name)).toEqual(["github__list-issues"]);
  });
});

describe("initBundles", () => {
  test("reloads bundles and membership from SQLite on a cold boot", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");
    await updateBundle("b", { enabled: false });

    // Simulate a process restart: wipe the hot-path cache by reloading from
    // the same (still-populated) SQLite handle.
    initBundles();

    expect(isBundleEnabled("b")).toBe(false);
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"]));
  });
});
