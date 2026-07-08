import { describe, test, expect, beforeEach, spyOn } from "bun:test";

// Stryker mutation backstop — RC5 (registry.ts lines 599-744): admin
// mutations for enable/disable (setClientEnabled, setToolEnabled) and
// dynamic guards (setClientGuards, setToolGuards). Each test/comment cites
// the exact line:column, mutator, and replacement it kills, per the house
// convention established across the P2 mutation-testing series (see
// reports/mutation/result.json).
//
// registry-enabled.test.ts and registry-guards.test.ts already cover the
// happy paths and the "unknown client/tool -> false" early returns — this
// file closes the SPECIFIC gaps Stryker reported surviving in that range:
//   - the notifyToolsChanged() broadcast must fire only on an actual
//     enabled-flag flip, never on a same-value no-op set (setClientEnabled
//     AND setToolEnabled both have this shape independently);
//   - the `client?.tools.find(...)` optional chain in both setToolEnabled
//     and setToolGuards must not throw when the live in-memory state has
//     diverged from a DB row the UPDATE/exists-check still matches — either
//     because the client was unregistered (drops live state only; SQLite
//     survives — only forgetClient purges) or because a tool row was
//     inserted directly via SQL without a live `client.tools` counterpart;
//   - setClientGuards's circuit-breaker column values (`cb?.field ?? null`)
//     must persist exactly the provided fields and null out every omitted
//     one — verified via a direct SQL readback, since the in-memory
//     `client.guards` is a passthrough of the caller's object and can't
//     observe a broken SQL write;
//   - updateCircuitBreakerConfig must be invoked only when
//     `guards.circuitBreaker` is actually present.
//
// Harness pattern matches the sibling files registry.test.ts /
// registry-enabled.test.ts / registry-guards.test.ts / registry-mutation-rc1.test.ts /
// registry-mutation-rc3.test.ts / registry-mutation-rc7.test.ts.
//
// Run: STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run test (never bare `bun test`).

import { registry } from "../../mcp/registry.js";
import * as mcpServerMod from "../../mcp/mcp-server.js";
import * as circuitBreakerMod from "../../middleware/circuit-breaker.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import type { RestToolDefinition } from "../../mcp/types.js";

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

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP);
}

/**
 * Inserts a `tools` row directly via SQL, bypassing register() entirely —
 * used to construct a DB/live-state divergence (a tool the DB knows about
 * that the live in-memory `client.tools` array does not), the same
 * construction the task calls out for L737's live-vs-DB gap.
 */
function insertGhostToolRow(clientName: string, toolName: string): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO tools (client_name, name, method, endpoint, description, input_schema, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(clientName, toolName, "GET", "/ghost", "ghost tool row inserted directly via SQL", "{}", 1, now, now);
}

function toolsEnabledRow(clientName: string, toolName: string): { enabled: number } | null {
  return getDb().query(`SELECT enabled FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName) as {
    enabled: number;
  } | null;
}

function clientGuardRow(clientName: string): {
  cb_failure_threshold: number | null;
  cb_reset_timeout_ms: number | null;
  cb_half_open_timeout_ms: number | null;
  cb_window_ms: number | null;
} | null {
  return getDb()
    .query(
      `SELECT cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms
       FROM client_guards WHERE client_name = ?`,
    )
    .get(clientName) as {
    cb_failure_threshold: number | null;
    cb_reset_timeout_ms: number | null;
    cb_half_open_timeout_ms: number | null;
    cb_window_ms: number | null;
  } | null;
}

function toolGuardRateLimitRow(clientName: string, toolName: string): { rate_limit_per_min: number | null } | null {
  return getDb()
    .query(`SELECT rate_limit_per_min FROM tool_guards WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { rate_limit_per_min: number | null } | null;
}

function clientEnabledRow(clientName: string): { enabled: number } | null {
  return getDb().query(`SELECT enabled FROM clients WHERE name = ?`).get(clientName) as {
    enabled: number;
  } | null;
}

// Registry tests must reset the shared module-level DB (and drain the live
// singleton) in beforeEach — unregister() deliberately does not purge SQLite,
// so state would otherwise leak across tests/files that reuse generic names.
beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// L611-613 — `if (result.changes === 0) { return false; }` unknown-client guard.
// (ConditionalExpression, BlockStatement)
// ---------------------------------------------------------------------------
describe("setClientEnabled — unknown client guard (L611-613)", () => {
  test("returns false for an unknown client (no UPDATE matched)", async () => {
    expect(await registry.setClientEnabled("nobody", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L617,619 — `const changed = client.enabled !== enabled; ... if (changed) {
// notifyToolsChanged(); }` (ConditionalExpression x2, BlockStatement).
// ---------------------------------------------------------------------------
describe("setClientEnabled — notifyToolsChanged fires only on an actual flip (L617,619)", () => {
  test("a same-value set (already enabled -> enabled) does not broadcast", async () => {
    await reg("svc"); // new client defaults to enabled: true
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      expect(await registry.setClientEnabled("svc", true)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(registry.getClient("svc")?.enabled).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a flipping set (enabled -> disabled) broadcasts exactly once", async () => {
    await reg("svc");
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      expect(await registry.setClientEnabled("svc", false)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(registry.getClient("svc")?.enabled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// L616:11 ConditionalExpression -> 'true' — `const client = this.clients.get(name);
// if (client) { ... }` live-state sync guard in setClientEnabled. On a live
// client this branch is already taken normally, so the only way to observe
// the mutation is a client that is undefined while the SQL UPDATE still
// matched a row: an unregistered-but-persisted client (unregister() drops
// live state but never purges SQLite — same construction as L639/L640 below).
// Forcing this branch to always run would dereference `client.enabled` on
// `undefined` and throw instead of returning true.
// ---------------------------------------------------------------------------
describe("setClientEnabled — live-state sync guard on an unregistered-but-persisted client (L616:11 ConditionalExpression->'true')", () => {
  test("does not throw and still persists the DB write when the client isn't live", async () => {
    await reg("svc");
    await registry.unregister("svc"); // live state gone; clients row survives
    expect(registry.getClient("svc")).toBeUndefined();

    await expect(registry.setClientEnabled("svc", false)).resolves.toBe(true);

    expect(clientEnabledRow("svc")?.enabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L634-636 — unknown client/tool guard for setToolEnabled (same shape as
// setClientEnabled's, already smoke-tested in registry-enabled.test.ts;
// re-asserted here as the baseline for the L639/640 tests below).
// ---------------------------------------------------------------------------
describe("setToolEnabled — unknown client/tool guard (L634-636)", () => {
  test("returns false for an unknown client, and for an unknown tool on a known client", async () => {
    expect(await registry.setToolEnabled("nobody", "nothing", false)).toBe(false);
    await reg("svc");
    expect(await registry.setToolEnabled("svc", "nonexistent-tool", false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L639 — `const tool = client?.tools.find((t) => t.name === toolName);`
// (OptionalChaining). The only way `client` can be undefined here while the
// SQL UPDATE still matched a row is a live/DB divergence: unregister() drops
// live state but never purges SQLite (only forgetClient does).
// ---------------------------------------------------------------------------
describe("setToolEnabled — optional chain on an unregistered-but-persisted client (L639)", () => {
  test("does not throw and still persists the DB write when the client isn't live", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc"); // live state gone; tools/clients rows survive
    expect(registry.getClient("svc")).toBeUndefined();

    await expect(registry.setToolEnabled("svc", "get-users", false)).resolves.toBe(true);

    expect(toolsEnabledRow("svc", "get-users")?.enabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L640,641,643,647 — `if (client && tool) { const changed = ...; if (changed)
// { notifyToolsChanged(); } } return true;` (ConditionalExpression x3,
// LogicalOperator, EqualityOperator, BlockStatement, BooleanLiteral). A "ghost"
// tool row (present in the DB, absent from the live client.tools array) makes
// `tool` undefined while `client` stays defined — the other half of L639's
// divergence, and the only way to exercise `if (client && tool)` with the
// second operand false.
// ---------------------------------------------------------------------------
describe("setToolEnabled — ghost DB tool row with no live counterpart (L640)", () => {
  test("does not throw and still persists the DB write when the tool has no live counterpart", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    insertGhostToolRow("svc", "ghost-tool");

    await expect(registry.setToolEnabled("svc", "ghost-tool", false)).resolves.toBe(true);

    expect(toolsEnabledRow("svc", "ghost-tool")?.enabled).toBe(0);
    // The real, live tool must be untouched.
    expect(registry.resolveTool("svc__get-users")?.tool.enabled).toBe(true);
  });
});

describe("setToolEnabled — notifyToolsChanged fires only on an actual flip (L641,643)", () => {
  test("a same-value set (already enabled -> enabled) does not broadcast", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]); // tools default to enabled: true
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      expect(await registry.setToolEnabled("svc", "get-users", true)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a flipping set (enabled -> disabled) broadcasts exactly once", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      spy.mockClear();
      expect(await registry.setToolEnabled("svc", "get-users", false)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// L683-686 — `cb?.failureThreshold ?? null`, `cb?.resetTimeoutMs ?? null`,
// `cb?.halfOpenTimeoutMs ?? null`, `cb?.windowMs ?? null` (OptionalChaining,
// LogicalOperator x3). The in-memory `client.guards` is a direct passthrough
// of the caller's object (L694: `client.guards = guards ?? undefined`), so it
// can never observe a broken SQL write — only a DB readback can.
// ---------------------------------------------------------------------------
describe("setClientGuards — circuit-breaker column values (L683-686)", () => {
  test("omitted fields persist as SQL NULL when only one field is provided", async () => {
    await reg("svc");
    expect(await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 5 } })).toBe(true);

    const row = clientGuardRow("svc");
    expect(row?.cb_failure_threshold).toBe(5);
    expect(row?.cb_reset_timeout_ms).toBeNull();
    expect(row?.cb_half_open_timeout_ms).toBeNull();
    expect(row?.cb_window_ms).toBeNull();
  });

  test("all four fields persist their own distinct provided value (no cross-mixing, no forced null)", async () => {
    await reg("svc");
    expect(
      await registry.setClientGuards("svc", {
        circuitBreaker: { failureThreshold: 11, resetTimeoutMs: 22, halfOpenTimeoutMs: 33, windowMs: 44 },
      }),
    ).toBe(true);

    expect(clientGuardRow("svc")).toEqual({
      cb_failure_threshold: 11,
      cb_reset_timeout_ms: 22,
      cb_half_open_timeout_ms: 33,
      cb_window_ms: 44,
    });
  });

  test("a guards object with no circuitBreaker at all nulls out every column", async () => {
    await reg("svc");
    expect(await registry.setClientGuards("svc", { extra: { note: "no cb" } })).toBe(true);

    expect(clientGuardRow("svc")).toEqual({
      cb_failure_threshold: null,
      cb_reset_timeout_ms: null,
      cb_half_open_timeout_ms: null,
      cb_window_ms: null,
    });
  });
});

// ---------------------------------------------------------------------------
// L693 — `if (guards?.circuitBreaker) { updateCircuitBreakerConfig(clientName,
// guards.circuitBreaker); }` (ConditionalExpression -> true).
// ---------------------------------------------------------------------------
describe("setClientGuards — updateCircuitBreakerConfig applied only when circuitBreaker is present (L693)", () => {
  test("no circuitBreaker field -> updateCircuitBreakerConfig is not called", async () => {
    await reg("svc");
    const spy = spyOn(circuitBreakerMod, "updateCircuitBreakerConfig");
    try {
      spy.mockClear();
      expect(await registry.setClientGuards("svc", { extra: { foo: 1 } })).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("circuitBreaker provided -> updateCircuitBreakerConfig is called once with exactly that value", async () => {
    await reg("svc");
    const spy = spyOn(circuitBreakerMod, "updateCircuitBreakerConfig");
    try {
      spy.mockClear();
      expect(await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 9 } })).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("svc", { failureThreshold: 9 });
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// L693:11 ConditionalExpression -> 'true' — `const client = this.clients.get(
// clientName); if (client) { ... }` live-state sync guard in setClientGuards.
// Same shape as setClientEnabled's L616 above: only observable when `client`
// is undefined while the SQL upsert still matched an existing client row (an
// unregistered-but-persisted client). Forcing this branch to always run
// would dereference `client.guards = ...` on `undefined` and throw instead
// of returning true.
// ---------------------------------------------------------------------------
describe("setClientGuards — live-state sync guard on an unregistered-but-persisted client (L693:11 ConditionalExpression->'true')", () => {
  test("does not throw and still persists the DB write when the client isn't live", async () => {
    await reg("svc");
    await registry.unregister("svc"); // live state gone; clients row survives
    expect(registry.getClient("svc")).toBeUndefined();

    await expect(registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 7 } })).resolves.toBe(true);

    expect(clientGuardRow("svc")?.cb_failure_threshold).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// L713:28 BlockStatement -> '{}' — the `if (guards === null) { db.query(
// \`DELETE FROM tool_guards ...\`).run(...); }` branch body in setToolGuards.
// Gutting this block to an empty one means clearing guards (passing `null`)
// silently leaves a stale tool_guards row behind instead of deleting it — the
// in-memory `client.guards` passthrough can't observe this (it's set from the
// caller's `guards` argument directly), only a DB readback can.
// ---------------------------------------------------------------------------
describe("setToolGuards — clearing with null actually deletes the row (L713:28 BlockStatement->'{}')", () => {
  test("guards=null on a tool with an existing tool_guards row deletes it", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 30 })).toBe(true);
    expect(toolGuardRateLimitRow("svc", "get-users")).not.toBeNull();

    expect(await registry.setToolGuards("svc", "get-users", null)).toBe(true);
    expect(toolGuardRateLimitRow("svc", "get-users")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L713 — `if (!exists) return false;` unknown client/tool guard for
// setToolGuards (BlockStatement -> '{}'). Already smoke-tested in
// registry-guards.test.ts; re-asserted here with an explicit DB-write check
// (no orphan tool_guards row can appear for a tool that doesn't exist) since
// this file owns the L707-743 range end to end.
// ---------------------------------------------------------------------------
describe("setToolGuards — unknown client/tool guard writes nothing (L713)", () => {
  test("returns false and writes no row for an unknown client or tool", async () => {
    expect(await registry.setToolGuards("nobody", "nothing", { rateLimitPerMin: 10 })).toBe(false);
    await reg("svc");
    expect(await registry.setToolGuards("svc", "nonexistent-tool", { rateLimitPerMin: 10 })).toBe(false);

    expect(toolGuardRateLimitRow("svc", "nonexistent-tool")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L737 — `const tool = client?.tools.find((t) => t.name === toolName); if
// (tool) { tool.guards = guards ?? undefined; }` (OptionalChaining,
// ConditionalExpression). Same live/DB-divergence shape as setToolEnabled's
// L639/L640 above, applied to setToolGuards: an unregistered-but-persisted
// client (client undefined) and a ghost tool row (client defined, tool
// undefined) — both must complete the DB write without throwing even though
// there is no live tool object to update.
// ---------------------------------------------------------------------------
describe("setToolGuards — live/DB divergence still persists without throwing (L737)", () => {
  test("optional chain: unregistered-but-persisted client does not throw, DB write still succeeds", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc");
    expect(registry.getClient("svc")).toBeUndefined();

    await expect(registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 15 })).resolves.toBe(true);

    expect(toolGuardRateLimitRow("svc", "get-users")?.rate_limit_per_min).toBe(15);
  });

  test("conditional: a ghost DB tool row (no live counterpart) does not throw, DB write still succeeds", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    insertGhostToolRow("svc", "ghost-tool");

    await expect(registry.setToolGuards("svc", "ghost-tool", { rateLimitPerMin: 21 })).resolves.toBe(true);

    expect(toolGuardRateLimitRow("svc", "ghost-tool")?.rate_limit_per_min).toBe(21);
    // The real, live tool's guards must be untouched.
    expect(registry.resolveTool("svc__get-users")?.tool.guards).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L667:28 BlockStatement -> '{}' — `if (guards === null) { db.query(`DELETE
// FROM client_guards WHERE client_name = ?`).run(clientName); }`. The live
// in-memory update (`client.guards = guards ?? undefined`) happens
// unconditionally further down, so registry-guards.test.ts's existing
// "null clears a previously-set guard" case (which only reads back
// `client.guards`) can't distinguish an emptied DELETE block — the live
// state looks cleared either way. Only a direct SQL readback of
// `client_guards` proves the row itself was actually deleted.
// ---------------------------------------------------------------------------
describe("setClientGuards — null actually deletes the client_guards row (L667)", () => {
  test("the underlying SQL row is gone, not just the live in-memory guards field", async () => {
    await reg("svc");
    await registry.setClientGuards("svc", { circuitBreaker: { failureThreshold: 9 } });
    expect(clientGuardRow("svc")).not.toBeNull();

    await registry.setClientGuards("svc", null);

    expect(clientGuardRow("svc")).toBeNull();
  });
});
