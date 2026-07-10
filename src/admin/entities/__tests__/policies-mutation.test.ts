/**
 * Stryker mutation-testing backstop for src/admin/entities/policies.ts.
 *
 * The hand-written sibling policies.test.ts already covers the CRUD happy path
 * and the two applyPolicyTo* helpers' basic success/skip/unknown-bundle cases.
 * This file gap-fills: getGuardPolicy()/policyNameExists() (untested at
 * baseline), row->domain field mapping (createdBy/createdAt/updatedAt/null
 * numeric fields), listGuardPolicies() ORDER BY name, updateGuardPolicy()'s
 * `??` vs `!== undefined` partial-update semantics (falsy-but-defined and
 * explicit-null cases), deleteGuardPolicy()'s not-found path, and a mixed
 * applied+skipped applyPolicyToTools() case.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import {
  createGuardPolicy,
  getGuardPolicy,
  policyNameExists,
  listGuardPolicies,
  updateGuardPolicy,
  deleteGuardPolicy,
  applyPolicyToTools,
} from "../../../admin/entities/policies.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

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

describe("getGuardPolicy", () => {
  test("returns the full mapped row for a valid id", () => {
    const created = createGuardPolicy({ name: "strict", rateLimitPerMin: 10, timeoutMs: 2000, actor: "alice" });
    const fetched = getGuardPolicy(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe("strict");
    expect(fetched?.rateLimitPerMin).toBe(10);
    expect(fetched?.timeoutMs).toBe(2000);
    expect(fetched?.createdBy).toBe("alice");
    expect(typeof fetched?.createdAt).toBe("number");
    expect(typeof fetched?.updatedAt).toBe("number");
  });

  test("maps null rateLimitPerMin/timeoutMs/createdBy through unchanged", () => {
    const created = createGuardPolicy({ name: "loose", rateLimitPerMin: null, timeoutMs: null, actor: null });
    const fetched = getGuardPolicy(created.id);
    expect(fetched?.rateLimitPerMin).toBeNull();
    expect(fetched?.timeoutMs).toBeNull();
    expect(fetched?.createdBy).toBeNull();
  });

  test("returns null for a non-integer id without ever querying the db", () => {
    // A DB round-trip would also (coincidentally) return null for these ids
    // since no row matches -- that alone can't distinguish "guarded" from
    // "guard removed". Spy on the query method itself to prove the
    // Number.isInteger guard short-circuits before any query happens.
    const querySpy = spyOn(getDb(), "query");
    try {
      expect(getGuardPolicy(1.5)).toBeNull();
      expect(getGuardPolicy(NaN)).toBeNull();
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      querySpy.mockRestore();
    }
  });

  test("returns null for a well-formed but non-existent id", () => {
    expect(getGuardPolicy(999999)).toBeNull();
  });
});

describe("policyNameExists", () => {
  test("is true only for the exact created name, false for others", () => {
    createGuardPolicy({ name: "unique-name", rateLimitPerMin: null, timeoutMs: null, actor: null });
    expect(policyNameExists("unique-name")).toBe(true);
    expect(policyNameExists("different-name")).toBe(false);
  });
});

describe("listGuardPolicies", () => {
  test("orders results alphabetically by name, not insertion order", () => {
    createGuardPolicy({ name: "zeta", rateLimitPerMin: null, timeoutMs: null, actor: null });
    createGuardPolicy({ name: "alpha", rateLimitPerMin: null, timeoutMs: null, actor: null });
    createGuardPolicy({ name: "mid", rateLimitPerMin: null, timeoutMs: null, actor: null });
    const names = listGuardPolicies().map((p) => p.name);
    expect(names).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("updateGuardPolicy", () => {
  test("returns null for a non-existent id and does not throw", () => {
    expect(updateGuardPolicy(999999, { name: "x" })).toBeNull();
  });

  test("an empty updates object preserves every existing field", () => {
    const created = createGuardPolicy({ name: "keep", rateLimitPerMin: 7, timeoutMs: 500, actor: "bob" });
    const updated = updateGuardPolicy(created.id, {});
    expect(updated?.name).toBe("keep");
    expect(updated?.rateLimitPerMin).toBe(7);
    expect(updated?.timeoutMs).toBe(500);
  });

  test("an explicit empty-string name is applied, not treated as absent (?? not ||)", () => {
    const created = createGuardPolicy({ name: "named", rateLimitPerMin: null, timeoutMs: null, actor: null });
    const updated = updateGuardPolicy(created.id, { name: "" });
    expect(updated?.name).toBe("");
    // Re-read through the sibling getter to prove the write really landed.
    expect(getGuardPolicy(created.id)?.name).toBe("");
  });

  test("explicit null rateLimitPerMin clears a previously-set value", () => {
    const created = createGuardPolicy({ name: "p1", rateLimitPerMin: 10, timeoutMs: 10, actor: null });
    const updated = updateGuardPolicy(created.id, { rateLimitPerMin: null });
    expect(updated?.rateLimitPerMin).toBeNull();
    // timeoutMs was not in the update -> must be preserved, not cleared too.
    expect(updated?.timeoutMs).toBe(10);
  });

  test("explicit null timeoutMs clears a previously-set value", () => {
    const created = createGuardPolicy({ name: "p2", rateLimitPerMin: 10, timeoutMs: 10, actor: null });
    const updated = updateGuardPolicy(created.id, { timeoutMs: null });
    expect(updated?.timeoutMs).toBeNull();
    expect(updated?.rateLimitPerMin).toBe(10);
  });

  test("omitting a field (undefined) leaves it untouched even when other fields change", () => {
    const created = createGuardPolicy({ name: "p3", rateLimitPerMin: 5, timeoutMs: 5, actor: null });
    const updated = updateGuardPolicy(created.id, { name: "p3-renamed" });
    expect(updated?.name).toBe("p3-renamed");
    expect(updated?.rateLimitPerMin).toBe(5);
    expect(updated?.timeoutMs).toBe(5);
  });
});

describe("deleteGuardPolicy", () => {
  test("returns false for a non-existent id", () => {
    expect(deleteGuardPolicy(999999)).toBe(false);
  });

  test("returns true once, then false on a repeat delete of the same id", () => {
    const created = createGuardPolicy({ name: "gone", rateLimitPerMin: null, timeoutMs: null, actor: null });
    expect(deleteGuardPolicy(created.id)).toBe(true);
    expect(deleteGuardPolicy(created.id)).toBe(false);
  });
});

describe("applyPolicyToTools", () => {
  test("mixed refs: applies to the real tool and skips the unknown one, reporting both precisely", async () => {
    await reg("svc", [makeTool("real")]);
    const p = createGuardPolicy({ name: "mix", rateLimitPerMin: 42, timeoutMs: 999, actor: null });

    const res = await applyPolicyToTools(p, [
      { client: "svc", tool: "real" },
      { client: "svc", tool: "ghost" },
    ]);

    expect(res.applied).toBe(1);
    expect(res.skipped).toEqual([{ tool: "svc__ghost", reason: "not found" }]);
    expect(registry.resolveTool("svc__real")?.tool.guards?.rateLimitPerMin).toBe(42);
    expect(registry.resolveTool("svc__real")?.tool.guards?.timeoutMs).toBe(999);
  });

  test("an empty ref list applies to nothing and skips nothing", async () => {
    const p = createGuardPolicy({ name: "empty", rateLimitPerMin: 1, timeoutMs: 1, actor: null });
    const res = await applyPolicyToTools(p, []);
    expect(res.applied).toBe(0);
    expect(res.skipped).toEqual([]);
  });
});
