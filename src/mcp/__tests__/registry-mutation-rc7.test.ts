import { describe, test, expect, beforeEach, spyOn } from "bun:test";

// Stryker mutation backstop — RC7 (registry.ts lines 862-935): annotateToolDrift
// (system-authored schema-drift note, stored in the SEPARATE tool_overrides.drift_note
// column) and applyGuardPolicy (rate-limit/timeout patch merge over existing tool
// guards, preserving the API-key allow-list). Each test/comment cites the exact
// line:column, mutator, and replacement it kills, per the house convention
// established across the P2 mutation-testing series (see reports/mutation/result.json).
//
// Harness pattern matches the sibling files registry.test.ts / registry-guards.test.ts /
// registry-mutation-rc1.test.ts / registry-mutation-rc3.test.ts.

import { registry } from "../../mcp/registry.js";
import * as mcpServerMod from "../../mcp/mcp-server.js";
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

function driftNoteRow(clientName: string, toolName: string): { drift_note: string | null } | null {
  return getDb()
    .query(`SELECT drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as { drift_note: string | null } | null;
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
// L862/863/865/866 — `if (!exists) return false;` — unknown client/tool guard.
// ---------------------------------------------------------------------------
describe("annotateToolDrift — unknown client/tool guard (L862/863/865/866)", () => {
  test("returns false for an unknown client", async () => {
    expect(await registry.annotateToolDrift("nobody", "nothing", "[drift]")).toBe(false);
  });

  test("returns false for an unknown tool on a known client, and writes no row", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(await registry.annotateToolDrift("svc", "does-not-exist", "[drift]")).toBe(false);
    expect(driftNoteRow("svc", "does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L874/875 — `if ((current?.drift_note ?? null) === note) { return true; }`
// Idempotency short-circuit: a no-op call skips both the write and the
// tools/list broadcast (EqualityOperator, LogicalOperator, OptionalChaining,
// BlockStatement, BooleanLiteral).
// ---------------------------------------------------------------------------
describe("annotateToolDrift — idempotency short-circuit (L874/875)", () => {
  test("calling with the identical note twice returns true both times but broadcasts only once", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const first = await registry.annotateToolDrift("svc", "get-users", "[drift] same note");
      expect(first).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);

      const second = await registry.annotateToolDrift("svc", "get-users", "[drift] same note");
      expect(second).toBe(true);
      // Idempotent short-circuit at L874 — must NOT re-write or re-broadcast.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("clearing with null when no drift note has ever been set is already the desired state — no write, no broadcast", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const spy = spyOn(mcpServerMod, "notifyToolsChanged");
    try {
      const result = await registry.annotateToolDrift("svc", "get-users", null);
      expect(result).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(driftNoteRow("svc", "get-users")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// L878/879 — the `note === null` clear branch's admin-field-preservation
// logic (ConditionalExpression, EqualityOperator, LogicalOperator x2,
// OptionalChaining x3, BlockStatement). Mirrors setToolOverride's own
// null-clear logic (drift_note survives an admin clear, and vice versa here).
// ---------------------------------------------------------------------------
describe("annotateToolDrift — clear branch preserves admin-authored fields (L878/879)", () => {
  test("clearing the drift note keeps the row when an admin override coexists", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolOverride("svc", "get-users", { description: "admin text" });
    await registry.annotateToolDrift("svc", "get-users", "[drift] schema changed");

    const cleared = await registry.annotateToolDrift("svc", "get-users", null);
    expect(cleared).toBe(true);

    // Row must survive — verified two ways: direct SQL and the live/detail view.
    const row = driftNoteRow("svc", "get-users");
    expect(row).not.toBeNull();
    expect(row?.drift_note).toBeNull();

    const detail = registry.getClientDetail("svc");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.override?.description).toBe("admin text");
    expect(tool?.override?.driftNote).toBeUndefined();
  });

  test("clearing a drift-only note (no admin override ever set) deletes the row entirely", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.annotateToolDrift("svc", "get-users", "[drift] schema changed");
    // Sanity — the row exists before the clear.
    expect(driftNoteRow("svc", "get-users")).not.toBeNull();

    await registry.annotateToolDrift("svc", "get-users", null);

    const row = getDb()
      .query(`SELECT 1 FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
      .get("svc", "get-users");
    expect(row).toBeNull();
  });

  // L879:37 `current?.param_overrides_json` — the description-only case above
  // already exercises `current?.description` (L879:13); this case sets an
  // admin override via ONLY `params` (no description, no displayName) so
  // `param_overrides_json` is the sole truthy field keeping the row alive.
  test("clearing the drift note keeps the row when the ONLY admin field set is param overrides (L879:37)", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolOverride("svc", "get-users", { params: { someProp: { description: "x" } } });
    await registry.annotateToolDrift("svc", "get-users", "[drift] schema changed");

    const cleared = await registry.annotateToolDrift("svc", "get-users", null);
    expect(cleared).toBe(true);

    const row = driftNoteRow("svc", "get-users");
    expect(row).not.toBeNull();
    expect(row?.drift_note).toBeNull();

    const detail = registry.getClientDetail("svc");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.override?.params).toEqual({ someProp: { description: "x" } });
    expect(tool?.override?.description).toBeUndefined();
    expect(tool?.override?.driftNote).toBeUndefined();
  });

  // L879:70 `current?.display_name` — same idea, isolating displayName as the
  // sole surviving admin field.
  test("clearing the drift note keeps the row when the ONLY admin field set is displayName (L879:70)", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolOverride("svc", "get-users", { displayName: "renamed-users" });
    await registry.annotateToolDrift("svc", "get-users", "[drift] schema changed");

    const cleared = await registry.annotateToolDrift("svc", "get-users", null);
    expect(cleared).toBe(true);

    const row = driftNoteRow("svc", "get-users");
    expect(row).not.toBeNull();
    expect(row?.drift_note).toBeNull();

    const detail = registry.getClientDetail("svc");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.override?.displayName).toBe("renamed-users");
    expect(tool?.override?.driftNote).toBeUndefined();
  });

  // NOTE on L879:13/37/70 (OptionalChaining current?.X -> current.X): the
  // three cases above isolate which OR-branch field keeps the row alive, but
  // do NOT by themselves prove the `?.` matters — that requires `current`
  // itself (not just a field on it) to be null/undefined at this line.
  // Traced empirically: the only way to reach this branch at all is via the
  // `note === null` arm (L878) AND failing the idempotency short-circuit at
  // L874 (`(current?.drift_note ?? null) === note`); with note === null that
  // short-circuit only fails when `current` exists AND `current.drift_note`
  // is itself non-null — i.e. a real row was already written by a PRIOR
  // non-null annotateToolDrift call (which always INSERTs a row, even with
  // no admin fields — see L888-894) or by setToolOverride. So `current` is
  // provably a real object every time L879 executes; `current?.X` and
  // `current.X` are behaviorally identical here. Confirmed by manually
  // applying each of the three OptionalChaining mutations (current.description
  // / current.param_overrides_json / current.display_name) against this file
  // + the DB-only/multi-tool cases below and re-running the suite — all pass
  // unchanged in every case, i.e. equivalent mutants, not a test-coverage gap.
});

// ---------------------------------------------------------------------------
// L882/884/885/889 — the UPSERT that sets a non-null note (StringLiteral,
// BlockStatement). Verify the exact stored string round-trips, both on
// initial insert and on the ON CONFLICT DO UPDATE overwrite path.
// ---------------------------------------------------------------------------
describe("annotateToolDrift — UPSERT stores the exact note string (L882/884/885/889)", () => {
  test("a fresh insert stores the exact drift_note string", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.annotateToolDrift("svc", "get-users", "[schema drift 2026-07-06: input changed]");

    const row = driftNoteRow("svc", "get-users");
    expect(row?.drift_note).toBe("[schema drift 2026-07-06: input changed]");
  });

  test("re-annotating with a different note overwrites the stored string via ON CONFLICT DO UPDATE", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.annotateToolDrift("svc", "get-users", "[drift] first note");
    await registry.annotateToolDrift("svc", "get-users", "[drift] second note");

    const row = driftNoteRow("svc", "get-users");
    expect(row?.drift_note).toBe("[drift] second note");
  });
});

// ---------------------------------------------------------------------------
// L898/899 — re-reading the row to rebuild the live tool.override (OptionalChaining,
// ArrowFunction, ConditionalExpression x2, EqualityOperator, BlockStatement).
// ---------------------------------------------------------------------------
describe("annotateToolDrift — refreshes the live in-memory override without a separate fetch (L898/899)", () => {
  test("registry.getClient(...).tools[...].override.driftNote reflects the new note immediately", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.annotateToolDrift("svc", "get-users", "[drift] live note");

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.override?.driftNote).toBe("[drift] live note");
  });

  test("clearing the note updates the live tool.override to no longer report a driftNote", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.annotateToolDrift("svc", "get-users", "[drift] temporary");
    await registry.annotateToolDrift("svc", "get-users", null);

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.override?.driftNote).toBeUndefined();
  });

  // L898:20 `client?.tools` — after unregister(), the client is gone from the
  // live `this.clients` map but the `tools` table row (checked by the L865
  // `exists` guard) is deliberately NOT purged (see beforeEach comment at the
  // top of this file), so annotateToolDrift can still be called for a
  // DB-only client. `client` is undefined here, so `client?.tools.find(...)`
  // must stay optional — removing the `?.` throws. This same call also
  // exercises L898:46/L899:11: `tool` resolves to undefined (client is
  // undefined), so `if (tool)` must NOT enter its body — a forced-true
  // mutant on either node would reach `tool.override = ...` with `tool`
  // undefined and throw too.
  test("annotating a DB-only (unregistered) client's tool does not throw and still persists the note (L898:20, L898:46, L899:11)", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc");
    expect(registry.getClient("svc")).toBeUndefined();

    await expect(registry.annotateToolDrift("svc", "get-users", "[drift] db-only")).resolves.toBe(true);
    expect(driftNoteRow("svc", "get-users")?.drift_note).toBe("[drift] db-only");
  });

  // L898:46/65 `t.name === toolName` — with only one live tool, forcing this
  // predicate to `true` is indistinguishable from the real check (`.find()`
  // still finds the same (only) tool). Registering a SECOND tool and
  // annotating the one that is NOT first in `client.tools` proves the lookup
  // is genuinely name-matched: a forced-true mutant would always resolve
  // `.find()` to the FIRST tool and patch the wrong one's live override.
  test("annotating one tool among several live tools patches only that tool's live override, not another's (L898:46-65)", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await registry.annotateToolDrift("svc", "tool-b", "[drift] only b");

    const client = registry.getClient("svc")!;
    const toolA = client.tools.find((t) => t.name === "tool-a");
    const toolB = client.tools.find((t) => t.name === "tool-b");
    expect(toolB?.override?.driftNote).toBe("[drift] only b");
    expect(toolA?.override?.driftNote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L908:14 BooleanLiteral -> 'false' — the function's final `return true;` on success.
// ---------------------------------------------------------------------------
describe("annotateToolDrift — returns true on success (L908)", () => {
  test("returns true after successfully persisting a new note", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(await registry.annotateToolDrift("svc", "get-users", "[drift] ok")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L922/924 — `if (!db.query(...).get(clientName, toolName)) return false;`
// unknown client/tool guard (BlockStatement, BooleanLiteral, ConditionalExpression x2,
// StringLiteral).
// ---------------------------------------------------------------------------
describe("applyGuardPolicy — unknown client/tool guard (L922/924)", () => {
  test("returns false for an unknown client", async () => {
    expect(await registry.applyGuardPolicy("nobody", "nothing", { rateLimitPerMin: 5 })).toBe(false);
  });

  test("returns false for an unknown tool on a known client", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    expect(await registry.applyGuardPolicy("svc", "does-not-exist", { rateLimitPerMin: 5 })).toBe(false);
  });

  // NOTE on L924 (`if (!db.query(...).get(clientName, toolName)) return
  // false;`, ConditionalExpression -> false): the "unknown tool on a known
  // client" case above already exercises the one-of-two-missing combination,
  // but the mutant still survives — traced empirically, this guard is
  // REDUNDANT with an identical existence check `setToolGuards()` performs
  // itself (same table, same WHERE clause, same params — see L710-711)
  // before every write. applyGuardPolicy does no synchronous work and no
  // `await` between its own L924 check and the tail call `return
  // this.setToolGuards(clientName, toolName, merged)`, so there is no way
  // for the two checks to observe different DB state, and bypassing L924
  // entirely (forcing `if (false)`) only ever skips straight to
  // setToolGuards' own guard, which independently returns `false` with no
  // observable side effect either way. Confirmed by manually applying the
  // `false` replacement at L924 and re-running this file's existing
  // unknown-client / unknown-tool tests unmodified — both still pass, for
  // every combination of missing client/tool, because setToolGuards' guard
  // masks it. Equivalent mutant, not a coverage gap.
});

// ---------------------------------------------------------------------------
// L930 — `const merged: ToolGuardConfig = { ...(rowToToolGuards(row) ?? {}) };`
// (ObjectLiteral, LogicalOperator). The whole point of applyGuardPolicy per its
// own doc comment: "preserving its API-key allow-list".
// ---------------------------------------------------------------------------
describe("applyGuardPolicy — merge preserves pre-existing guard fields (L930)", () => {
  test("a rateLimitPerMin-only patch does not clobber a pre-existing API-key allow-list", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { allowedKeyHashes: ["abc123"], rateLimitPerMin: 10 });

    const ok = await registry.applyGuardPolicy("svc", "get-users", { rateLimitPerMin: 20 });
    expect(ok).toBe(true);

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.allowedKeyHashes).toEqual(["abc123"]);
    expect(tool?.guards?.rateLimitPerMin).toBe(20);
  });

  test("an unrelated patch on a tool with no prior guards at all still succeeds and sets only the patched field", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    const ok = await registry.applyGuardPolicy("svc", "get-users", { timeoutMs: 750 });
    expect(ok).toBe(true);

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.timeoutMs).toBe(750);
    expect(tool?.guards?.rateLimitPerMin).toBeUndefined();
    expect(tool?.guards?.allowedKeyHashes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L931/932 — `if (patch.rateLimitPerMin !== undefined) merged.rateLimitPerMin =
// patch.rateLimitPerMin ?? undefined; if (patch.timeoutMs !== undefined)
// merged.timeoutMs = patch.timeoutMs ?? undefined;` (ConditionalExpression x2,
// EqualityOperator, LogicalOperator x2). Three cases per field: omitted (unchanged),
// a number (replaced), and explicit null (cleared to undefined, not literal null).
// ---------------------------------------------------------------------------
describe("applyGuardPolicy — patch field semantics (L931/932)", () => {
  test("omitting rateLimitPerMin from the patch leaves the existing value unchanged", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 10, timeoutMs: 500 });

    await registry.applyGuardPolicy("svc", "get-users", { timeoutMs: 999 });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.rateLimitPerMin).toBe(10);
    expect(tool?.guards?.timeoutMs).toBe(999);
  });

  test("setting rateLimitPerMin to a number replaces the existing value", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 10 });

    await registry.applyGuardPolicy("svc", "get-users", { rateLimitPerMin: 50 });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.rateLimitPerMin).toBe(50);
  });

  test("setting rateLimitPerMin to null clears the guard to undefined, not literal null", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 10 });

    await registry.applyGuardPolicy("svc", "get-users", { rateLimitPerMin: null });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.rateLimitPerMin).toBeUndefined();
  });

  test("omitting timeoutMs from the patch leaves the existing value unchanged", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { timeoutMs: 1234 });

    await registry.applyGuardPolicy("svc", "get-users", { rateLimitPerMin: 5 });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.timeoutMs).toBe(1234);
  });

  test("setting timeoutMs to a number replaces the existing value", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { timeoutMs: 1000 });

    await registry.applyGuardPolicy("svc", "get-users", { timeoutMs: 2000 });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.timeoutMs).toBe(2000);
  });

  test("setting timeoutMs to null clears the guard to undefined, not literal null", async () => {
    await reg("svc", [makeTool({ name: "get-users" })]);
    await registry.setToolGuards("svc", "get-users", { timeoutMs: 1000 });

    await registry.applyGuardPolicy("svc", "get-users", { timeoutMs: null });

    const tool = registry.getClient("svc")!.tools.find((t) => t.name === "get-users");
    expect(tool?.guards?.timeoutMs).toBeUndefined();
  });
});
