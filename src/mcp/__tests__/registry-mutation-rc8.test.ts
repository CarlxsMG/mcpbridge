import { describe, test, expect, beforeEach } from "bun:test";

// Stryker mutation backstop — RC8 (registry.ts lines 941-1052): resolveTool,
// effectiveAdvertised (private — drives getAllMcpTools/getMcpToolsForClient/
// getMcpToolsForKeys), getAllMcpTools, getMcpToolsForClient, getClientTools,
// getMcpToolsForKeys. Each test/comment cites the exact line:column, mutator,
// and replacement it kills, per the house convention established across the
// P2 mutation-testing series (see reports/mutation/result.json) and continued
// in the registry.ts RC series (rc1/rc3/rc7/rc10).
//
// Harness pattern matches the sibling files registry.test.ts /
// registry-mutation-rc1.test.ts / registry-mutation-rc7.test.ts.
//
// Line numbers below are cited against the CURRENT src/mcp/registry.ts (read
// fresh for this file); a couple of the originally-reported mutant locations
// had drifted by a handful of lines since the report was generated (unrelated
// edits elsewhere in the file) — each citation below notes the current actual
// location alongside the mutant description so the mapping stays unambiguous.

import { registry } from "../../mcp/registry.js";
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

/** inputSchema with a single real property ("foo") that has its own description. */
function schemaWithFoo(fooDescription: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      foo: { type: "string", description: fooDescription },
    },
  };
}

const DEFAULT_HEALTH = "http://example.com/health";
const DEFAULT_BASE = "http://example.com";
const DEFAULT_IP = "1.2.3.4";
const DEFAULT_RESOLVED_IP = "1.2.3.4";

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, DEFAULT_HEALTH, DEFAULT_IP, DEFAULT_BASE, DEFAULT_RESOLVED_IP);
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  // Fresh in-memory SQLite per test — unregister() deliberately doesn't purge
  // persisted enabled/guards/override state, so a shared DB would leak it
  // across tests that reuse generic client names like "svc".
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// resolveTool — L941-960
//
//   const entry = this.toolIndex.get(canonical);
//   if (!entry) { return undefined; }                          // ~L945-947
//   const client = this.clients.get(entry.clientName);
//   if (!client) { return undefined; }                         // ~L950-952 (task: L950)
//   const tool = client.tools.find((t) => t.name === entry.toolName);
//   if (!tool) { return undefined; }                           // ~L954-957 (task: L954/L955)
//   return { client, tool };
//
// REACHABILITY NOTE for the `!client` guard (~L950) and the `!tool` guard
// (~L954/955), verified empirically by reading every writer of `toolIndex`/
// `clients`/`client.tools` in registry.ts:
//   - register()/registerMcp() (L314-357, L425-466) always delete this
//     client's OLD toolIndex entries and then set toolIndex entries for
//     EVERY tool it just put in `client.tools`, inside the same synchronous
//     withLock callback — never one without the other.
//   - teardownLiveClient() (L475-508), the sole path for unregister/
//     forgetClient/reconcileFromDb-eviction, deletes every toolIndex entry
//     for the client (step 3) BEFORE deleting the client from `clients`
//     (step 4), synchronously, with no `await` in between.
//   - reconcileFromDb() (L537-598) only ever adds a client with toolIndex
//     entries set in the same synchronous block, or removes one via
//     teardownLiveClient — same guarantee.
//   - No method ever removes a single tool from `client.tools` in place
//     without also touching `toolIndex` (there is no such method at all).
// Since every write to `toolIndex`, `clients`, and `client.tools` is
// synchronous (no `await` inside teardownLiveClient/the register lock body)
// and JS is single-threaded, there is no way — via the public API, in a
// single-process test — to observe `toolIndex` pointing at a client that
// isn't in `clients`, or at a tool name that isn't in that client's live
// `tools` array. These two guards are real defensive code (they matter for
// multi-instance skew, per reconcileFromDb's own doc comment — a case this
// single-process suite can't simulate), not equivalent-in-all-contexts
// mutants, but they are not constructible from here without reaching into
// the class's private fields — which no sibling RC file in this series does
// — so per the task's own fallback instruction we cover the straightforward
// `!entry` guard robustly instead and document this reachability limit here.
// ---------------------------------------------------------------------------

describe("Registry.resolveTool — L945-947 `!entry` guard (unknown canonical key)", () => {
  test("returns undefined for a name that was never registered at all", () => {
    expect(registry.resolveTool("totally-unknown-key")).toBeUndefined();
  });

  test("returns undefined for a well-formed composite key whose client was never registered", () => {
    expect(registry.resolveTool("ghost-client__ghost-tool")).toBeUndefined();
  });

  test("returns undefined for a known client's name paired with a tool that was never registered on it", async () => {
    await reg("svc", [makeTool({ name: "real-tool" })]);
    expect(registry.resolveTool("svc__not-a-real-tool")).toBeUndefined();
  });

  test("returns undefined again once the client is unregistered (index entry actually removed, not just shadowed)", async () => {
    await reg("svc", [makeTool({ name: "real-tool" })]);
    expect(registry.resolveTool("svc__real-tool")).not.toBeUndefined();
    await registry.unregister("svc");
    expect(registry.resolveTool("svc__real-tool")).toBeUndefined();
  });

  test("the positive case still resolves correctly (sanity check the guard doesn't over-fire)", async () => {
    await reg("svc", [makeTool({ name: "real-tool" })]);
    const resolved = registry.resolveTool("svc__real-tool");
    expect(resolved?.client.name).toBe("svc");
    expect(resolved?.tool.name).toBe("real-tool");
  });
});

// ---------------------------------------------------------------------------
// effectiveAdvertised (private, L967-993) — exercised through
// getMcpToolsForClient/getAllMcpTools, which are its only callers.
// ---------------------------------------------------------------------------

// L975:18 LogicalOperator — `const base = ov.description ?? tool.description;`
// An override with NO description (only a displayName here) must still fall
// back to the tool's OWN real description, not become undefined. A `??` ->
// `&&` mutation would make `undefined && tool.description` short-circuit to
// `undefined` instead of falling back.
describe("effectiveAdvertised — L975 description falls back to tool.description when override has none", () => {
  test("override with only a displayName (no description) advertises the tool's real description", async () => {
    await reg("svc", [makeTool({ name: "t1", description: "Real description" })]);
    const ok = await registry.setToolOverride("svc", "t1", { displayName: "renamed" });
    expect(ok).toBe(true);

    const tools = registry.getMcpToolsForClient("svc");
    const advertised = tools.find((t) => t.name === "svc__renamed");
    expect(advertised).toBeDefined();
    expect(advertised!.description).toBe("Real description");
  });
});

// L980:40 StringLiteral -> '``' — `const description = ov.driftNote ? \`${ov.driftNote} ${base}\` : base;`
// Set BOTH an admin override description and a drift note, and assert the
// advertised description is exactly "<driftNote> <base>" — driftNote, one
// literal space, then base, concatenated exactly as the template shows.
describe("effectiveAdvertised — L980 driftNote/base template concatenation", () => {
  test("driftNote + admin override description concatenate as '<driftNote> <base>'", async () => {
    await reg("svc", [makeTool({ name: "t1", description: "Base description" })]);
    await registry.setToolOverride("svc", "t1", { description: "Custom description" });
    await registry.annotateToolDrift("svc", "t1", "[drift 2026-07-06]");

    const advertised = registry.getMcpToolsForClient("svc").find((t) => t.name === "svc__t1");
    expect(advertised?.description).toBe("[drift 2026-07-06] Custom description");
  });

  test("clearing the drift note reverts the advertised description to the base override text alone", async () => {
    await reg("svc", [makeTool({ name: "t1", description: "Base description" })]);
    await registry.setToolOverride("svc", "t1", { description: "Custom description" });
    await registry.annotateToolDrift("svc", "t1", "[drift 2026-07-06]");
    await registry.annotateToolDrift("svc", "t1", null);

    const advertised = registry.getMcpToolsForClient("svc").find((t) => t.name === "svc__t1");
    expect(advertised?.description).toBe("Custom description");
  });
});

// L982 (ConditionalExpression x4, LogicalOperator x2, EqualityOperator) —
// `if (ov.params && Object.keys(ov.params).length > 0 && inputSchema && typeof inputSchema === "object")`
describe("effectiveAdvertised — L982 inputSchema clone gating", () => {
  test("(a) override with NO params field at all — advertised inputSchema is the ORIGINAL object, not a clone", async () => {
    await reg("svc-noparams", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo original") })]);
    await registry.setToolOverride("svc-noparams", "t1", { description: "D2" });

    const stored = registry.resolveTool("svc-noparams__t1")!.tool.inputSchema;
    const advertised = registry.getMcpToolsForClient("svc-noparams").find((t) => t.name === "svc-noparams__t1")!;

    // Reference equality — proves the clone branch was skipped entirely, not
    // just that the content happens to match.
    expect(advertised.inputSchema).toBe(stored);
  });

  test("(b) override with params: {} (empty object) — must also skip the clone, since Object.keys({}).length > 0 is false", async () => {
    // setToolOverride's own normalization always collapses an empty/no-op
    // params map back to `undefined` before it's ever persisted (see
    // setToolOverride L761-767), so `ov.params === {}` can never arrive here
    // via the public override API — only a row written some other way (e.g.
    // a future direct-write code path, or a manual DB edit) could produce
    // it. Construct that state directly against the same tool_overrides
    // table setToolOverride itself writes (mirrors the precedent in
    // proxy-mutation-c5's quarantine-reason test), then re-register so
    // persistRestRegistration (registry-persistence.ts L207-217) re-reads
    // the row into the live tool, exactly as it does on every registration.
    await reg("svc-emptyparams", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo t3") })]);
    getDb()
      .query(
        `INSERT INTO tool_overrides (client_name, tool_name, description, param_overrides_json, display_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_name, tool_name) DO UPDATE SET
           description = excluded.description,
           param_overrides_json = excluded.param_overrides_json,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
      )
      .run("svc-emptyparams", "t1", "Custom t3 desc", "{}", null, Date.now());
    await reg("svc-emptyparams", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo t3") })]);

    // Sanity check the constructed state actually has ov.params = {} (truthy,
    // empty) before relying on it below.
    const liveOverride = registry.resolveTool("svc-emptyparams__t1")!.tool.override;
    expect(liveOverride?.params).toEqual({});
    expect(liveOverride?.description).toBe("Custom t3 desc");

    const stored = registry.resolveTool("svc-emptyparams__t1")!.tool.inputSchema;
    const advertised = registry.getMcpToolsForClient("svc-emptyparams").find((t) => t.name === "svc-emptyparams__t1")!;

    expect(advertised.description).toBe("Custom t3 desc");
    // Clone must still be skipped — reference equality to the stored schema.
    expect(advertised.inputSchema).toBe(stored);
  });

  test("(c) override with a REAL non-empty params object — must clone AND patch, leaving the stored tool's own inputSchema untouched", async () => {
    await reg("svc-realparams", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo original") })]);
    await registry.setToolOverride("svc-realparams", "t1", { params: { foo: { description: "Patched foo" } } });

    const stored = registry.resolveTool("svc-realparams__t1")!.tool.inputSchema as {
      properties: Record<string, { description: string }>;
    };
    const advertised = registry.getMcpToolsForClient("svc-realparams").find((t) => t.name === "svc-realparams__t1")!;
    const advertisedProps = (advertised.inputSchema as { properties: Record<string, { description: string }> })
      .properties;

    // The clone was patched...
    expect(advertisedProps.foo.description).toBe("Patched foo");
    // ...but the tool's OWN stored inputSchema was never mutated (proves clone, not mutation).
    expect(stored.properties.foo.description).toBe("Foo original");
    // And the advertised object is genuinely a different object, not the same reference.
    expect(advertised.inputSchema).not.toBe(registry.resolveTool("svc-realparams__t1")!.tool.inputSchema);
  });
});

// L982:74 `typeof inputSchema === "object"` (ConditionalExpression -> true).
// REACHABILITY NOTE, verified empirically: `inputSchema` here is always
// `tool.inputSchema`, and BOTH registration paths that can ever populate a
// live `RegisteredTool` — register() (L287-288) and registerMcp()
// (L401-402) — validate `if (!tool.inputSchema || typeof tool.inputSchema
// !== "object") throw new Error(...)` before the tool is ever stored. There
// is no other writer of `client.tools`. So by the time effectiveAdvertised
// runs, `inputSchema` is provably always a truthy object — the `inputSchema
// &&` and `typeof inputSchema === "object"` conjuncts can never observably
// be false via the public API, and forcing either to `true` changes nothing
// reachable. Confirmed by manually applying the `true` replacement at
// L982:74 and re-running every test in this file's "L982 inputSchema clone
// gating" describe block unmodified — all still pass identically. Equivalent
// mutant, not a coverage gap.

// L985:11 `if (props)` (ConditionalExpression -> true) — the OUTER guard
// around the params-patch loop, distinct from L987's `props[p]` inner guard
// (already covered by the "property that doesn't exist in the schema"
// case above, which needs `props` to already be a real object). This one
// needs `clone.properties` itself to be absent: registration only requires
// `inputSchema.type === "object"` (L291/L404), NOT a `properties` key, so a
// tool can legally register with an inputSchema that has no `properties` at
// all. A forced-true mutant would then still enter the loop and evaluate
// `props[p]` on `undefined`, throwing.
describe("effectiveAdvertised — L985 outer `if (props)` guard when the schema has no properties field at all", () => {
  test("a param override against a schema with no `properties` key does not throw, and invents no properties object", async () => {
    await reg("svc-noprops", [makeTool({ name: "t1", inputSchema: { type: "object" } })]);
    await registry.setToolOverride("svc-noprops", "t1", { params: { foo: { description: "whatever" } } });

    expect(() => registry.getMcpToolsForClient("svc-noprops")).not.toThrow();

    const advertised = registry.getMcpToolsForClient("svc-noprops").find((t) => t.name === "svc-noprops__t1")!;
    expect((advertised.inputSchema as Record<string, unknown>).properties).toBeUndefined();
  });
});

// L985/987 (ConditionalExpression x3, LogicalOperator, EqualityOperator, ObjectLiteral) —
// `for (const [p, o] of Object.entries(ov.params)) { if (props[p] && o.description !== undefined) props[p].description = o.description; }`
describe("effectiveAdvertised — L985/987 params-patch loop edge cases", () => {
  test("(a) a param override for a property that doesn't exist in the schema is skipped, not thrown", async () => {
    await reg("svc-unknownprop", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo orig") })]);
    await registry.setToolOverride("svc-unknownprop", "t1", {
      params: { "nonexistent-prop": { description: "whatever" } },
    });

    expect(() => registry.getMcpToolsForClient("svc-unknownprop")).not.toThrow();

    const advertised = registry.getMcpToolsForClient("svc-unknownprop").find((t) => t.name === "svc-unknownprop__t1")!;
    const props = (advertised.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.foo.description).toBe("Foo orig");
    expect(props["nonexistent-prop"]).toBeUndefined();
  });

  test("(b) a param override entry with no description field is skipped, leaving the property's description unchanged", async () => {
    // As with L982(b), setToolOverride's own normalization drops any params
    // entry lacking a `description` before persisting (L763-766), so
    // `o.description === undefined` for an entry that survives into `ov`
    // can't be produced via the public override API — write the row
    // directly against tool_overrides (same technique as L982(b) above),
    // then re-register so the live tool picks it up.
    await reg("svc-nodesc", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo orig2") })]);
    getDb()
      .query(
        `INSERT INTO tool_overrides (client_name, tool_name, description, param_overrides_json, display_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_name, tool_name) DO UPDATE SET
           description = excluded.description,
           param_overrides_json = excluded.param_overrides_json,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
      )
      .run("svc-nodesc", "t1", null, JSON.stringify({ foo: {} }), null, Date.now());
    await reg("svc-nodesc", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo orig2") })]);

    // Sanity check the constructed state.
    const liveOverride = registry.resolveTool("svc-nodesc__t1")!.tool.override;
    expect(liveOverride?.params).toEqual({ foo: {} });

    const advertised = registry.getMcpToolsForClient("svc-nodesc").find((t) => t.name === "svc-nodesc__t1")!;
    const props = (advertised.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    // Must remain the ORIGINAL description — not overwritten with undefined.
    expect(props.foo.description).toBe("Foo orig2");
  });

  test("(c) a normal param override DOES patch the matching property's description", async () => {
    await reg("svc-normalpatch", [makeTool({ name: "t1", inputSchema: schemaWithFoo("Foo orig3") })]);
    await registry.setToolOverride("svc-normalpatch", "t1", { params: { foo: { description: "Patched" } } });

    const advertised = registry.getMcpToolsForClient("svc-normalpatch").find((t) => t.name === "svc-normalpatch__t1")!;
    const props = (advertised.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.foo.description).toBe("Patched");
  });
});

// L992:12 ObjectLiteral -> '{}' — the function's final `return { name, description, inputSchema };`
describe("effectiveAdvertised — L992 return object has exactly {name, description, inputSchema}", () => {
  test("advertised tool has all three fields present and correct", async () => {
    await reg("svc-shape", [makeTool({ name: "t1", description: "Shape description" })]);
    const [advertised] = registry.getMcpToolsForClient("svc-shape");

    expect(Object.keys(advertised).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(advertised.name).toBe("svc-shape__t1");
    expect(advertised.description).toBe("Shape description");
    expect(advertised.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

// ---------------------------------------------------------------------------
// getAllMcpTools — L1001-1012
// L1002:99 ArrayDeclaration -> '["Stryker was here"]' — the `result: {...}[] = []` initializer.
// ---------------------------------------------------------------------------

describe("Registry.getAllMcpTools — L1002 result array is exactly the servable set, nothing poisoned", () => {
  test("returns exactly one entry per servable tool, across every enabled client", async () => {
    await reg("svc-a", [makeTool({ name: "t1" })]);
    await reg("svc-b", [makeTool({ name: "t1" })]);

    const result = registry.getAllMcpTools();
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name).sort()).toEqual(["svc-a__t1", "svc-b__t1"]);
    // Every element must actually be an advertised-tool object, not a stray literal.
    for (const t of result) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
    }
  });

  test("excludes a tool that is individually disabled", async () => {
    await reg("svc-a", [makeTool({ name: "t1" })]);
    await reg("svc-b", [makeTool({ name: "t1" })]);
    await registry.setToolEnabled("svc-b", "t1", false);

    const result = registry.getAllMcpTools();
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("svc-a__t1");
  });

  test("excludes every tool belonging to a disabled client", async () => {
    await reg("svc-a", [makeTool({ name: "t1" })]);
    await registry.setClientEnabled("svc-a", false);

    expect(registry.getAllMcpTools()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMcpToolsForKeys — L1040-1052 (task's original citation said "L1029",
// which in the current file is getClientTools' line — the actual loop body
// this mutant targets is the `for (const [clientName, client] of this.clients)
// { for (const tool of client.tools) { ... } }` block below).
// BlockStatement -> '{}' on the inner loop body would make the function
// always return an empty array regardless of `keys`.
// ---------------------------------------------------------------------------

describe("Registry.getMcpToolsForKeys — inner loop body actually filters by key + isServable", () => {
  test("returns exactly the tools whose composite key is in the set", async () => {
    await reg("client1", [makeTool({ name: "tool1" })]);
    await reg("client2", [makeTool({ name: "tool2" })]);

    const result = registry.getMcpToolsForKeys(new Set(["client1__tool1"]));
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("client1__tool1");
  });

  test("a matching key whose tool is disabled is still excluded (isServable filter applies inside the same loop)", async () => {
    await reg("client1", [makeTool({ name: "tool1" })]);
    await reg("client2", [makeTool({ name: "tool2" })]);
    await registry.setToolEnabled("client2", "tool2", false);

    const result = registry.getMcpToolsForKeys(new Set(["client1__tool1", "client2__tool2"]));
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("client1__tool1");
  });

  test("an empty key set returns an empty array (loop runs but never pushes)", async () => {
    await reg("client1", [makeTool({ name: "tool1" })]);
    expect(registry.getMcpToolsForKeys(new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getClientTools — L1029-1031
// L1030:12 OptionalChaining -> 'this.clients.get(name).tools' —
// `return this.clients.get(name)?.tools;`
// Removing the `?.` would throw for an unknown client instead of returning undefined.
// ---------------------------------------------------------------------------

describe("Registry.getClientTools — L1030 optional chaining on an unknown client", () => {
  test("returns undefined (does not throw) for an unknown client name", () => {
    expect(() => registry.getClientTools("does-not-exist")).not.toThrow();
    expect(registry.getClientTools("does-not-exist")).toBeUndefined();
  });

  test("returns the live tools array for a known client", async () => {
    await reg("svc-x", [makeTool({ name: "t1" }), makeTool({ name: "t2" })]);
    const tools = registry.getClientTools("svc-x");
    expect(tools?.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
  });
});
