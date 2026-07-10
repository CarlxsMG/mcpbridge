import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { registry } from "../../../mcp/registry.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import {
  initBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  listBundles,
  getBundleDetail,
  isBundleEnabled,
  getBundleToolKeys,
  getBundleComposites,
} from "../../../admin/tool-composition/bundles.js";
import { createComposite, initComposites } from "../../../admin/tool-composition/composites.js";
import * as mcpServerMod from "../../../mcp/mcp-server.js";
import * as loggerMod from "../../../logger.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

/**
 * Gap-fill for bundles.test.ts (left untouched). That file already covers the
 * "happy path + basic tool validation" surface for every exported function
 * except getBundleComposites (zero coverage there before this file). This
 * file focuses on what it didn't: composite-tool references (an entirely
 * separate dimension from the tool-ref validation it already covers),
 * notifyToolsChanged/scopeChanged call-precision in updateBundle, the
 * updated_at bump-only-when-neither-description-nor-enabled-changed branch,
 * explicit-null vs omitted description, empty-array-clears-membership for
 * both tools and composites, short-circuit ordering when a combined update's
 * tools/composites are validated in sequence, multi-item filter/narrowing
 * fixtures for both findUnknownTool and findUnknownComposite, and the
 * initBundles() log call.
 */

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

/** Registers a composite with a single step targeting an already-registered tool. */
async function addComposite(name: string, targetClient: string, targetTool: string): Promise<void> {
  const result = await createComposite(
    name,
    undefined,
    { type: "object", properties: {} },
    [{ targetClient, targetTool, argsTemplate: {} }],
    "test-actor",
  );
  if (!result.ok) throw new Error(`addComposite(${name}) failed: ${JSON.stringify(result.error)}`);
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  initBundles();
  initComposites();
});

describe("createBundle — composite references", () => {
  test("creates a bundle referencing a valid composite tool and persists + caches it", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("summarize", "github", "list-issues");

    const result = await createBundle("b", undefined, [], "test-actor", ["summarize"]);

    expect(result.ok).toBe(true);
    expect(getBundleComposites("b")).toEqual(new Set(["summarize"]));
    expect(getBundleDetail("b")?.composites).toEqual(["summarize"]);
  });

  test("rejects an unknown composite reference and does not create the bundle", async () => {
    const result = await createBundle("b", undefined, [], "test-actor", ["nope"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TOOL");
      expect(result.error.message).toBe('Unknown composite tool "nope"');
    }
    expect(getBundleDetail("b")).toBeUndefined();
  });

  test("detects the unknown composite within a larger list of otherwise-valid composite refs", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");

    const result = await createBundle("b", undefined, [], "test-actor", ["sum-a", "nope"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Unknown composite tool "nope"');
    expect(getBundleDetail("b")).toBeUndefined();
  });

  test("dedupes repeated composite names in the same payload", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("summarize", "github", "list-issues");

    const result = await createBundle("b", undefined, [], "test-actor", ["summarize", "summarize"]);

    expect(result.ok).toBe(true);
    expect(getBundleDetail("b")?.composites).toEqual(["summarize"]);
  });

  test("defaults composites to an empty list when the parameter is omitted", async () => {
    const result = await createBundle("b", undefined, [], "test-actor");

    expect(result.ok).toBe(true);
    expect(getBundleComposites("b")).toEqual(new Set());
    expect(getBundleDetail("b")?.composites).toEqual([]);
  });
});

describe("createBundle — error message text", () => {
  test("INVALID_NAME error carries the exact expected message", async () => {
    const result = await createBundle("Not Valid!", undefined, [], "test-actor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Bundle name must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
    }
  });

  test("ALREADY_EXISTS error carries the exact expected message", async () => {
    await createBundle("dupe", undefined, [], "test-actor");
    const result = await createBundle("dupe", undefined, [], "test-actor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Bundle "dupe" already exists');
    }
  });
});

describe("createBundle — multi-item tool-ref narrowing", () => {
  test("detects the unknown tool within a larger list of otherwise-valid tool refs", async () => {
    await reg("github", [makeTool({ name: "a" }), makeTool({ name: "b" })]);

    const result = await createBundle(
      "b",
      undefined,
      [
        { client: "github", tool: "a" },
        { client: "github", tool: "nonexistent" },
        { client: "github", tool: "b" },
      ],
      "test-actor",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Unknown tool "github__nonexistent"');
    expect(getBundleDetail("b")).toBeUndefined();
  });
});

describe("createBundle — notifyToolsChanged", () => {
  test("calls notifyToolsChanged exactly once on successful creation", async () => {
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const result = await createBundle("b", undefined, [], "test-actor");
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not notify when creation fails validation (invalid name)", async () => {
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const result = await createBundle("Not Valid!", undefined, [], "test-actor");
      expect(result.ok).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("updateBundle — composite references", () => {
  test("replacing composites fully replaces membership without touching tools", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await addComposite("sum-b", "github", "list-issues");
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor", ["sum-a"]);

    const result = await updateBundle("b", { composites: ["sum-b"] });

    expect(result.ok).toBe(true);
    expect(getBundleComposites("b")).toEqual(new Set(["sum-b"]));
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"]));
  });

  test("rejects an unknown composite in a composites-list replacement without mutating existing membership", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["sum-a"]);

    const result = await updateBundle("b", { composites: ["nope"] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TOOL");
    expect(getBundleComposites("b")).toEqual(new Set(["sum-a"]));
  });

  test("clearing composites to an empty array removes membership", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["sum-a"]);

    const result = await updateBundle("b", { composites: [] });

    expect(result.ok).toBe(true);
    expect(getBundleComposites("b")).toEqual(new Set());
  });
});

describe("updateBundle — tools edge cases", () => {
  test("clearing tools to an empty array removes membership", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");

    const result = await updateBundle("b", { tools: [] });

    expect(result.ok).toBe(true);
    expect(getBundleToolKeys("b")).toEqual(new Set());
  });

  test("when a combined update's tools are invalid, valid composites are not applied either (short-circuits before the transaction)", async () => {
    await reg("github", [makeTool({ name: "a" })]);
    await addComposite("sum-a", "github", "a");
    await createBundle("b", undefined, [{ client: "github", tool: "a" }], "test-actor", []);

    const result = await updateBundle("b", {
      tools: [{ client: "github", tool: "bogus" }],
      composites: ["sum-a"],
    });

    expect(result.ok).toBe(false);
    expect(getBundleComposites("b")).toEqual(new Set());
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__a"]));
  });

  test("when a combined update's composites are invalid, previously-valid tools changes are not applied either", async () => {
    await reg("github", [makeTool({ name: "a" }), makeTool({ name: "b" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "a" }], "test-actor", []);

    const result = await updateBundle("b", {
      tools: [{ client: "github", tool: "b" }],
      composites: ["nope"],
    });

    expect(result.ok).toBe(false);
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__a"]));
  });
});

describe("updateBundle — error message text", () => {
  test("NOT_FOUND error carries the exact expected message", async () => {
    const result = await updateBundle("nope", { enabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Bundle "nope" not found');
  });

  test("tools UNKNOWN_TOOL error carries the exact expected message", async () => {
    await createBundle("b", undefined, [], "test-actor");
    const result = await updateBundle("b", { tools: [{ client: "github", tool: "nope" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Unknown tool "github__nope"');
  });

  test("composites UNKNOWN_TOOL error carries the exact expected message", async () => {
    await createBundle("b", undefined, [], "test-actor");
    const result = await updateBundle("b", { composites: ["nope"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('Unknown composite tool "nope"');
  });
});

describe("updateBundle — persists tool/composite replacement to SQLite itself, not merely the cache", () => {
  test("replacing tools updates the SQL row set (getBundleDetail reads straight from SQL, unlike getBundleToolKeys)", async () => {
    await reg("github", [makeTool({ name: "list-issues" }), makeTool({ name: "create-issue" })]);
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");

    await updateBundle("b", { tools: [{ client: "github", tool: "create-issue" }] });

    expect(getBundleDetail("b")?.tools).toEqual([{ client: "github", tool: "create-issue" }]);
  });

  test("replacing composites updates the SQL row set (getBundleDetail reads straight from SQL, unlike getBundleComposites)", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await addComposite("sum-b", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["sum-a"]);

    await updateBundle("b", { composites: ["sum-b"] });

    expect(getBundleDetail("b")?.composites).toEqual(["sum-b"]);
  });
});

describe("updateBundle — description explicit null vs omitted", () => {
  test("updates description to explicit null, clearing it", async () => {
    await createBundle("b", "initial desc", [], "test-actor");

    const result = await updateBundle("b", { description: null });

    expect(result.ok).toBe(true);
    expect(getBundleDetail("b")?.description).toBeNull();
  });
});

describe("updateBundle — enabled round trip", () => {
  test("re-enabling a previously-disabled bundle updates the cache back to enabled", async () => {
    await createBundle("b", undefined, [], "test-actor");
    await updateBundle("b", { enabled: false });
    expect(isBundleEnabled("b")).toBe(false);

    const result = await updateBundle("b", { enabled: true });

    expect(result.ok).toBe(true);
    expect(isBundleEnabled("b")).toBe(true);
  });
});

describe("updateBundle — notifyToolsChanged / scopeChanged precision", () => {
  test("enabled-only change notifies", async () => {
    await createBundle("b", undefined, [], "test-actor");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      await updateBundle("b", { enabled: false });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("tools-only change notifies", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await createBundle("b", undefined, [], "test-actor");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      await updateBundle("b", { tools: [{ client: "github", tool: "list-issues" }] });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("composites-only change notifies", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      await updateBundle("b", { composites: ["sum-a"] });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("description-only change does not notify", async () => {
    await createBundle("b", "v1", [], "test-actor");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const result = await updateBundle("b", { description: "v2" });
      expect(result.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("an empty update object does not notify and does not bump updatedAt", async () => {
    const dateSpy = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await createBundle("b", "v1", [], "test-actor");
      dateSpy.mockReturnValue(9_999_999);
      const spy = spyOn(mcpServerMod, "notifyToolsChanged");
      try {
        const result = await updateBundle("b", {});
        expect(result.ok).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        expect(getBundleDetail("b")?.updatedAt).toBe(1000);
      } finally {
        spy.mockRestore();
      }
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("updateBundle — updated_at bump-only-when-neither-description-nor-enabled-changed", () => {
  test("a tools-only update bumps updatedAt even though description/enabled are both untouched", async () => {
    const dateSpy = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await reg("github", [makeTool({ name: "list-issues" }), makeTool({ name: "create-issue" })]);
      const created = await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor");
      expect(created.ok).toBe(true);
      expect(getBundleDetail("b")).toMatchObject({ createdAt: 1000, updatedAt: 1000 });

      dateSpy.mockReturnValue(2000);
      const updated = await updateBundle("b", { tools: [{ client: "github", tool: "create-issue" }] });
      expect(updated.ok).toBe(true);

      const detail = getBundleDetail("b");
      expect(detail?.createdAt).toBe(1000);
      expect(detail?.updatedAt).toBe(2000);
      // The enabled flag must not be perturbed by a tools-only update either.
      expect(isBundleEnabled("b")).toBe(true);
    } finally {
      dateSpy.mockRestore();
    }
  });

  test("a composites-only update bumps updatedAt even though tools/description/enabled are all untouched", async () => {
    const dateSpy = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await reg("github", [makeTool({ name: "list-issues" })]);
      await addComposite("sum-a", "github", "list-issues");
      const created = await createBundle("b", undefined, [], "test-actor");
      expect(created.ok).toBe(true);
      expect(getBundleDetail("b")).toMatchObject({ createdAt: 1000, updatedAt: 1000 });

      dateSpy.mockReturnValue(3000);
      const updated = await updateBundle("b", { composites: ["sum-a"] });
      expect(updated.ok).toBe(true);

      const detail = getBundleDetail("b");
      expect(detail?.createdAt).toBe(1000);
      expect(detail?.updatedAt).toBe(3000);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe("updateBundle — a change to one field must not corrupt the live cache for an untouched field", () => {
  test("an enabled-only update leaves existing tool and composite membership in the cache untouched", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await createBundle("b", undefined, [{ client: "github", tool: "list-issues" }], "test-actor", ["sum-a"]);

    const result = await updateBundle("b", { enabled: false });

    expect(result.ok).toBe(true);
    expect(getBundleToolKeys("b")).toEqual(new Set(["github__list-issues"]));
    expect(getBundleComposites("b")).toEqual(new Set(["sum-a"]));
  });

  test("a description-only update leaves the cached enabled flag untouched", async () => {
    await createBundle("b", "v1", [], "test-actor");
    expect(isBundleEnabled("b")).toBe(true);

    const result = await updateBundle("b", { description: "v2" });

    expect(result.ok).toBe(true);
    expect(isBundleEnabled("b")).toBe(true);
  });
});

describe("updateBundle — tolerates a DB-persisted bundle missing from the live cache", () => {
  test("does not throw and still persists the change when there is no live cache entry for it", async () => {
    // Simulate a row that exists in SQLite but was never routed through
    // createBundle/initBundles in this process (e.g. written by another HA
    // instance before this one's next reconcile) — liveBundles has no entry.
    const now = Date.now();
    getDb()
      .query(
        `INSERT INTO mcp_bundles (name, description, enabled, created_at, updated_at, created_by) VALUES (?, NULL, 1, ?, ?, ?)`,
      )
      .run("orphan", now, now, "other-instance");

    const result = await updateBundle("orphan", { enabled: false });

    expect(result.ok).toBe(true);
    expect(getBundleDetail("orphan")?.enabled).toBe(false);
  });
});

describe("deleteBundle — notifyToolsChanged", () => {
  test("does not notify when the bundle doesn't exist", async () => {
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      expect(await deleteBundle("nope")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("notifies exactly once when the bundle is actually removed", async () => {
    await createBundle("gone", undefined, [], "test-actor");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      expect(await deleteBundle("gone")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getBundleComposites", () => {
  test("returns undefined for an unknown bundle", () => {
    expect(getBundleComposites("never-existed")).toBeUndefined();
  });

  test("returns the exact composite-name set for a known bundle", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await addComposite("sum-b", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["sum-a", "sum-b"]);

    expect(getBundleComposites("b")).toEqual(new Set(["sum-a", "sum-b"]));
  });
});

describe("getBundleToolKeys — unknown bundle", () => {
  test("returns undefined for a bundle that was never created", () => {
    expect(getBundleToolKeys("never-existed")).toBeUndefined();
  });
});

describe("isBundleEnabled — unknown bundle", () => {
  test("returns false for an unknown bundle name", () => {
    expect(isBundleEnabled("never-existed")).toBe(false);
  });
});

describe("listBundles — multiple distinct bundles", () => {
  test("returns bundles ordered by name with correct per-bundle tool counts", async () => {
    await reg("github", [makeTool({ name: "a" }), makeTool({ name: "b" })]);
    await createBundle("zeta", undefined, [{ client: "github", tool: "a" }], "test-actor");
    await createBundle(
      "alpha",
      undefined,
      [
        { client: "github", tool: "a" },
        { client: "github", tool: "b" },
      ],
      "test-actor",
    );

    const all = listBundles();
    expect(all.map((b) => b.name)).toEqual(["alpha", "zeta"]);
    expect(all.find((b) => b.name === "alpha")?.toolsCount).toBe(2);
    expect(all.find((b) => b.name === "zeta")?.toolsCount).toBe(1);
  });

  test("reports enabled and disabled bundles correctly within the same list (not all-true, not all-false)", async () => {
    await createBundle("on", undefined, [], "test-actor");
    await createBundle("off", undefined, [], "test-actor");
    await updateBundle("off", { enabled: false });

    const all = listBundles();
    expect(all.find((b) => b.name === "on")?.enabled).toBe(true);
    expect(all.find((b) => b.name === "off")?.enabled).toBe(false);
  });
});

describe("getBundleDetail — composites ordering and full shape", () => {
  test("returns composites sorted by name regardless of insertion order", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("bbb", "github", "list-issues");
    await addComposite("aaa", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["bbb", "aaa"]);

    expect(getBundleDetail("b")?.composites).toEqual(["aaa", "bbb"]);
  });

  test("returns the full detail shape including composites and timestamps", async () => {
    const dateSpy = spyOn(Date, "now").mockReturnValue(5000);
    try {
      await reg("github", [makeTool({ name: "a" })]);
      await addComposite("sum-a", "github", "a");
      await createBundle("b", "desc", [{ client: "github", tool: "a" }], "test-actor", ["sum-a"]);

      expect(getBundleDetail("b")).toEqual({
        name: "b",
        description: "desc",
        enabled: true,
        createdAt: 5000,
        updatedAt: 5000,
        tools: [{ client: "github", tool: "a" }],
        composites: ["sum-a"],
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  test("reflects a disabled bundle's enabled flag as false (not just the enabled-true default case)", async () => {
    await createBundle("b", undefined, [], "test-actor");
    await updateBundle("b", { enabled: false });

    expect(getBundleDetail("b")?.enabled).toBe(false);
  });
});

describe("initBundles — logging and composite cold-boot reload", () => {
  test("logs the loaded bundle count", async () => {
    await createBundle("b1", undefined, [], "test-actor");
    await createBundle("b2", undefined, [], "test-actor");

    const logSpy = spyOn(loggerMod, "log");
    try {
      initBundles();
      expect(logSpy).toHaveBeenCalledWith("info", "Loaded MCP bundles", { count: 2 });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("reloads composite membership from SQLite on a cold boot", async () => {
    await reg("github", [makeTool({ name: "list-issues" })]);
    await addComposite("sum-a", "github", "list-issues");
    await createBundle("b", undefined, [], "test-actor", ["sum-a"]);

    // Simulate a process restart: reload the hot-path cache from the same
    // (still-populated) SQLite handle.
    initBundles();

    expect(getBundleComposites("b")).toEqual(new Set(["sum-a"]));
  });

  test("cold-boot reload preserves an enabled bundle's enabled flag as true (not just the disabled case the hand-written test covers)", async () => {
    await createBundle("b", undefined, [], "test-actor");
    expect(isBundleEnabled("b")).toBe(true);

    initBundles();

    expect(isBundleEnabled("b")).toBe(true);
  });

  test("tolerates an orphaned tool/composite membership row with no corresponding bundle row (defensive optional chaining)", () => {
    // Under normal operation this can't happen — mcp_bundle_tools/
    // mcp_bundle_composites both declare `ON DELETE CASCADE` against
    // mcp_bundles and PRAGMA foreign_keys is ON for every connection (see
    // db/connection.ts) — so we briefly turn enforcement off to construct
    // the otherwise-unreachable shape and confirm initBundles() degrades
    // gracefully (skips the row) instead of throwing on `cache.get(...)`
    // returning undefined for a name that was never inserted into the cache.
    const db = getDb();
    db.exec("PRAGMA foreign_keys = OFF;");
    try {
      const now = Date.now();
      db.query(
        `INSERT INTO mcp_bundle_tools (bundle_name, client_name, tool_name, created_at) VALUES (?, ?, ?, ?)`,
      ).run("ghost-bundle", "github", "list-issues", now);
      db.query(`INSERT INTO mcp_bundle_composites (bundle_name, composite_name, created_at) VALUES (?, ?, ?)`).run(
        "ghost-bundle",
        "ghost-composite",
        now,
      );
    } finally {
      db.exec("PRAGMA foreign_keys = ON;");
    }

    expect(() => initBundles()).not.toThrow();
    expect(getBundleToolKeys("ghost-bundle")).toBeUndefined();
  });
});
