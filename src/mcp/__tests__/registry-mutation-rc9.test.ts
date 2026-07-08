import { describe, test, expect, beforeEach, spyOn } from "bun:test";

// Stryker mutation-testing backstop — cluster RC9 (registry.ts L1060-1192):
// resetCircuitBreaker, listClientsSummary (paginated/searchable admin
// listing), listAllTools. Every test below is written against a concrete
// surviving mutant, cited by line:mutator in its own describe/test title so
// a re-run of `bun run test:mutate` can be cross-checked against this file.
//
// House convention (see src/security/__tests__/compare.test.ts and
// src/mcp/__tests__/registry.test.ts): fresh in-memory SQLite + a fully
// drained live registry before every test (unregister() only tears down
// in-memory state, so __resetDbForTesting() is still required to avoid
// leaking persisted enabled/guards/team rows across tests reusing generic
// names).

import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import * as circuitBreakerMod from "../../middleware/circuit-breaker.js";
import { createTeam, setClientTeam } from "../../admin/entities/teams.js";
import { setToolTags } from "../../tool-meta/tool-tags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

const DEFAULT_HEALTH = "http://example.com/health";
const DEFAULT_BASE = "http://example.com";
const DEFAULT_IP = "1.2.3.4";
const DEFAULT_RESOLVED_IP = "1.2.3.4";

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP);
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// resetCircuitBreaker — L1061-1065
// ---------------------------------------------------------------------------

describe("Registry.resetCircuitBreaker", () => {
  test("L1062 BlockStatement/BooleanLiteral/ConditionalExpression — unknown client returns false and never calls removeCircuitBreaker", () => {
    const spy = spyOn(circuitBreakerMod, "removeCircuitBreaker");
    try {
      expect(registry.resetCircuitBreaker("nobody-registered")).toBe(false);
      // Kills the BlockStatement mutant (emptying the if-body would fall
      // through to removeCircuitBreaker()+return true for an unknown
      // client) and the ConditionalExpression-forced-false variant of the
      // same guard.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("L1062-1064 BooleanLiteral/ConditionalExpression — a live client returns true and removeCircuitBreaker is called with its exact name", async () => {
    await reg("cb-live");
    const spy = spyOn(circuitBreakerMod, "removeCircuitBreaker");
    try {
      expect(registry.resetCircuitBreaker("cb-live")).toBe(true);
      // Kills the ConditionalExpression-forced-true variant (would return
      // false even for a live client) and the BooleanLiteral true<->false
      // swap on the final `return true`.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("cb-live");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// listClientsSummary — L1073-1150
// ---------------------------------------------------------------------------

describe("Registry.listClientsSummary — limit clamping (L1084 Math.min/Math.max)", () => {
  test("limit: 0 clamps UP to 1, not down to 0 or negative (kills outer Math.min→Math.max swap)", async () => {
    await reg("a");
    await reg("b");
    await reg("c");
    const result = registry.listClientsSummary({ limit: 0 });
    // Real: Math.min(Math.max(0,1),200) = 1 -> exactly 1 item, more pages left.
    // Outer-swapped mutant: Math.max(Math.max(0,1),200) = 200 -> would return all 3.
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("a");
    expect(result.nextCursor).toBe("a");
  });

  test("limit: 5000 clamps DOWN to 200, not down to 1 (kills inner Math.max→Math.min swap)", async () => {
    await reg("a");
    await reg("b");
    await reg("c");
    const result = registry.listClientsSummary({ limit: 5000 });
    // Real: Math.min(Math.max(5000,1),200) = 200 -> all 3 fit, no more pages.
    // Inner-swapped mutant: Math.min(Math.min(5000,1),200) = 1 -> only 1 item, more pages left.
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeUndefined();
  });

  test("limit omitted entirely defaults to 50, not some other constant", async () => {
    // 51 clients (c000..c050), zero-padded so lexical sort == numeric sort.
    for (let i = 0; i <= 50; i++) {
      await reg(`c${String(i).padStart(3, "0")}`);
    }
    const result = registry.listClientsSummary({});
    expect(result.items).toHaveLength(50);
    expect(result.items[0].name).toBe("c000");
    expect(result.items[49].name).toBe("c049");
    expect(result.nextCursor).toBe("c049");
  });
});

describe("Registry.listClientsSummary — opts.cursor keyset pagination (L1089/1090)", () => {
  test("a cursor advances strictly past that name, never repeating or returning everything", async () => {
    await reg("a");
    await reg("b");
    await reg("c");

    const first = registry.listClientsSummary({ limit: 1 });
    expect(first.items.map((i) => i.name)).toEqual(["a"]);
    expect(first.nextCursor).toBe("a");

    // Kills: BlockStatement (cursor ignored -> would repeat "a"),
    // ConditionalExpression forced-false (same effect), ConditionalExpression
    // forced-true (would apply an undefined cursor param on the FIRST call
    // above and break it), and the "c.name > ?" StringLiteral mutant (an
    // empty/garbled SQL fragment either throws or changes the result set).
    const second = registry.listClientsSummary({ cursor: first.nextCursor, limit: 1 });
    expect(second.items.map((i) => i.name)).toEqual(["b"]);
    expect(second.nextCursor).toBe("b");
  });
});

describe("Registry.listClientsSummary — opts.q substring search (L1093)", () => {
  test("only names containing the substring are returned", async () => {
    await reg("alpha-one");
    await reg("alpha-two");
    await reg("beta-one");

    const result = registry.listClientsSummary({ q: "alpha" });
    expect(result.items.map((i) => i.name).sort()).toEqual(["alpha-one", "alpha-two"]);
  });
});

describe("Registry.listClientsSummary — opts.enabled filter (L1097/1098)", () => {
  test("filters strictly by the enabled flag in each direction", async () => {
    await reg("en-a");
    await reg("en-b");
    await registry.setClientEnabled("en-b", false);

    const onlyEnabled = registry.listClientsSummary({ q: "en-", enabled: true });
    expect(onlyEnabled.items.map((i) => i.name)).toEqual(["en-a"]);

    const onlyDisabled = registry.listClientsSummary({ q: "en-", enabled: false });
    expect(onlyDisabled.items.map((i) => i.name)).toEqual(["en-b"]);
  });
});

describe("Registry.listClientsSummary — opts.teamId tenancy scoping (L1102/1103)", () => {
  test("a numeric teamId returns only that team's clients", async () => {
    await reg("ta");
    await reg("tb");
    await reg("tc");
    const t1 = createTeam("rc9-team-one", null) as { id: number };
    const t2 = createTeam("rc9-team-two", null) as { id: number };
    expect(setClientTeam("ta", t1.id)).toBe(true);
    expect(setClientTeam("tb", t2.id)).toBe(true);
    // tc stays unowned (team_id null).

    const result = registry.listClientsSummary({ teamId: t1.id });
    expect(result.items.map((i) => i.name)).toEqual(["ta"]);
    // Non-null teamId echoed back exactly -- also guards L1141's `?? null`.
    expect(result.items[0].teamId).toBe(t1.id);
  });

  test('teamId: null does NOT apply the filter (typeof opts.teamId === "number" check)', async () => {
    await reg("ta");
    await reg("tb");
    await reg("tc");
    const t1 = createTeam("rc9-team-three", null) as { id: number };
    setClientTeam("ta", t1.id);

    // Explicit null must behave like "no team filter" -- every client across
    // every team (and unowned) comes back.
    const result = registry.listClientsSummary({ teamId: null });
    expect(result.items.map((i) => i.name).sort()).toEqual(["ta", "tb", "tc"]);
  });
});

describe("Registry.listClientsSummary — whereClause AND-joins conditions (L1106)", () => {
  test("no filters at all returns everything, no WHERE clause", async () => {
    await reg("nf-a");
    await reg("nf-b");
    const result = registry.listClientsSummary({});
    expect(result.items.map((i) => i.name).sort()).toEqual(["nf-a", "nf-b"]);
  });

  test("two filters are ANDed together, not ORed or ignored", async () => {
    await reg("combo-a");
    await reg("combo-b");
    await registry.setClientEnabled("combo-b", false);
    await reg("other-a");

    // q matches combo-a & combo-b but not other-a; enabled:true matches
    // combo-a & other-a but not combo-b. Only the intersection (combo-a)
    // should come back -- proving " AND " join, not some other separator
    // or a whereClause that's applied unconditionally / never applied.
    const result = registry.listClientsSummary({ q: "combo", enabled: true });
    expect(result.items.map((i) => i.name)).toEqual(["combo-a"]);
  });
});

describe("Registry.listClientsSummary — hasMore / page slicing boundary (L1127/1128/1149)", () => {
  test("exactly limit+1 rows: hasMore is true, page is truncated to limit, nextCursor is the LAST item on the page", async () => {
    await reg("x1");
    await reg("x2");
    await reg("x3");
    const result = registry.listClientsSummary({ limit: 2 });
    expect(result.items.map((i) => i.name)).toEqual(["x1", "x2"]);
    // Exact last-page-item name -- guards the L1149 `page[page.length - 1]` arithmetic
    // (an off-by-one would read page[page.length] === undefined or page[0]).
    expect(result.nextCursor).toBe("x2");
  });

  test("exactly limit rows: hasMore is false and nextCursor is undefined (boundary is > , not >=)", async () => {
    await reg("x1");
    await reg("x2");
    const result = registry.listClientsSummary({ limit: 2 });
    expect(result.items.map((i) => i.name)).toEqual(["x1", "x2"]);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("Registry.listClientsSummary — per-item live/status/teamId mapping (L1134-1136, L1141)", () => {
  test("a live client reports live:true and its real in-memory status", async () => {
    await reg("live-c");
    const result = registry.listClientsSummary({ q: "live-c" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].live).toBe(true);
    expect(result.items[0].status).toBe("healthy");
  });

  test("a DB-only (unregistered but not forgotten) client reports live:false and status:null", async () => {
    await reg("gone-c");
    // unregister() tears down in-memory state only -- it deliberately does
    // NOT purge the SQLite row (that's forgetClient()'s job) -- so this is
    // exactly the "registered before but not currently live" case the
    // docstring above listClientsSummary calls out.
    await registry.unregister("gone-c");

    const result = registry.listClientsSummary({ q: "gone-c" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].live).toBe(false);
    expect(result.items[0].status).toBeNull();
  });

  test("teamId defaults to null (not undefined) for a client with no team assigned", async () => {
    await reg("noteam-c");
    const result = registry.listClientsSummary({ q: "noteam-c" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].teamId).toBeNull();
  });
});

describe("Registry.listClientsSummary — L1134:18 raw enabled field mapping (unfiltered)", () => {
  test("each item's `enabled` field reflects its actual per-client state when opts.enabled is NOT passed", async () => {
    await reg("map-enabled-a");
    await reg("map-enabled-b");
    await registry.setClientEnabled("map-enabled-b", false);

    // Deliberately omit opts.enabled -- the "opts.enabled filter" describe
    // block above already covers the server-side WHERE-clause filter path;
    // this exercises the raw per-item `r.enabled === 1` mapping itself, with
    // both an enabled and a disabled row present in the SAME unfiltered result.
    const result = registry.listClientsSummary({ q: "map-enabled-" });
    expect(result.items).toHaveLength(2);
    const a = result.items.find((i) => i.name === "map-enabled-a");
    const b = result.items.find((i) => i.name === "map-enabled-b");
    // Kills ConditionalExpression->true (b would also read enabled:true) and
    // EqualityOperator -> 'r.enabled !== 1' (both would flip: a:false, b:true).
    expect(a?.enabled).toBe(true);
    expect(b?.enabled).toBe(false);
  });
});

describe("Registry.listClientsSummary — opts.status post-filter (L1145/1146)", () => {
  test("filters the already-built page by in-memory status; omitting it returns all regardless of status", async () => {
    await reg("healthy-c");
    await reg("degraded-c");
    registry.markClientStatus("degraded-c", "degraded");

    const filtered = registry.listClientsSummary({ q: "-c", status: "degraded" });
    expect(filtered.items.map((i) => i.name)).toEqual(["degraded-c"]);

    const unfiltered = registry.listClientsSummary({ q: "-c" });
    expect(unfiltered.items.map((i) => i.name).sort()).toEqual(["degraded-c", "healthy-c"]);
  });
});

// ---------------------------------------------------------------------------
// listAllTools — L1160-1192
// ---------------------------------------------------------------------------

describe("Registry.listAllTools", () => {
  test("L1167/L1184 maps exactly the registered (client, tool) pairs with the correct shape", async () => {
    await reg("la-svc", [
      makeTool({ name: "tool-one", description: "First tool" }),
      makeTool({ name: "tool-two", description: "Second tool" }),
    ]);

    const all = registry.listAllTools();
    const mine = all.filter((r) => r.client === "la-svc");
    expect(mine).toHaveLength(2);

    const one = mine.find((r) => r.tool === "tool-one");
    expect(one).toBeDefined();
    expect(one!.client).toBe("la-svc");
    expect(one!.tool).toBe("tool-one");
    expect(one!.description).toBe("First tool");
    expect(one!.enabled).toBe(true);
    expect(one!.clientEnabled).toBe(true);
    expect(Array.isArray(one!.tags)).toBe(true);
  });

  test("L1188/1189 enabled/clientEnabled reflect all 4 boolean combinations", async () => {
    await reg("ec-1", [makeTool({ name: "t1" })]); // client enabled, tool enabled
    await reg("ec-2", [makeTool({ name: "t1" })]);
    await registry.setToolEnabled("ec-2", "t1", false); // client enabled, tool disabled
    await reg("ec-3", [makeTool({ name: "t1" })]);
    await registry.setClientEnabled("ec-3", false); // client disabled, tool enabled
    await reg("ec-4", [makeTool({ name: "t1" })]);
    await registry.setClientEnabled("ec-4", false);
    await registry.setToolEnabled("ec-4", "t1", false); // client disabled, tool disabled

    const all = registry.listAllTools();
    const get = (c: string) => all.find((r) => r.client === c && r.tool === "t1");

    expect(get("ec-1")).toMatchObject({ enabled: true, clientEnabled: true });
    expect(get("ec-2")).toMatchObject({ enabled: false, clientEnabled: true });
    expect(get("ec-3")).toMatchObject({ enabled: true, clientEnabled: false });
    expect(get("ec-4")).toMatchObject({ enabled: false, clientEnabled: false });
  });

  test("L1190 tags come from getAllToolTags keyed by client__tool, defaulting to [] when untagged", async () => {
    await reg("tag-svc", [makeTool({ name: "tagged-tool" }), makeTool({ name: "untagged-tool" })]);
    expect(setToolTags("tag-svc", "tagged-tool", ["alpha", "beta"])).toBe(true);

    const all = registry.listAllTools();
    const tagged = all.find((r) => r.client === "tag-svc" && r.tool === "tagged-tool");
    const untagged = all.find((r) => r.client === "tag-svc" && r.tool === "untagged-tool");

    expect(tagged).toBeDefined();
    expect(tagged!.tags).toEqual(["alpha", "beta"]);
    expect(untagged).toBeDefined();
    // Specifically [] -- not undefined, not a poisoned placeholder array.
    expect(untagged!.tags).toEqual([]);
  });
});
