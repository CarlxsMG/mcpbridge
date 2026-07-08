import { describe, test, expect, beforeEach } from "bun:test";

// -----------------------------------------------------------------------------
// Stryker mutation-testing backstop — RC2: Registry.register() (src/mcp/registry.ts
// lines 233-358), the REST-client registration entry point. Structurally parallel
// to registerMcp() (covered by registry-mutation-rc1.test.ts's sibling file
// registry-mutation-rc3.test.ts) but validates method/endpoint instead of
// upstreamName, includes the path-traversal check (already covered by rc1), and
// mutates `tools[]` in place during sanitization (rather than registerMcp's
// immutable `.map()`).
//
// Each describe block cites the exact line:column, mutator, and replacement it
// targets, verified against the CURRENT checked-out source (re-derived by hand
// via `awk`/`index()` column counts — some line numbers drift between a stale
// mutation-report snapshot and the file as it stands today, so what's cited
// below is the actual current location, not a report artifact). Harness pattern
// matches the sibling files registry.test.ts / registry-mutation-rc1.test.ts.
// -----------------------------------------------------------------------------

import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
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
// L240:36 BooleanLiteral->'true' — the `retryNonSafeMethods: boolean = false`
// DEFAULT PARAMETER value on register()'s signature. Every call through this
// file's `reg()` helper already omits the 7th argument (the helper's own
// signature has no retryNonSafeMethods parameter at all), so this is already
// exercised implicitly everywhere — this test just pins the assertion
// directly against the live client's persisted field.
// ---------------------------------------------------------------------------

describe("Registry.register — retryNonSafeMethods default parameter (L240:36 BooleanLiteral->'true')", () => {
  test("omitting the 7th argument defaults retry_non_safe_methods to false, not true", async () => {
    await reg("svc-default-retry");
    expect(registry.getClient("svc-default-retry")!.retry_non_safe_methods).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L242:18 ConditionalExpression->'false' — the CLIENT-LEVEL name-required
// guard, `if (!name || typeof name !== "string") throw ...`, distinct from
// the TOOL-LEVEL `tool.name` guard at L253 covered just below (same shape,
// different variable, different AST node — Stryker mutates each
// independently).
// ---------------------------------------------------------------------------

describe("Registry.register — client name required (L242:18 ConditionalExpression->'false')", () => {
  test("an empty client name throws the exact client-level message", async () => {
    await expect(reg("")).rejects.toThrow("Client name is required and must be a non-empty string");
  });

  // "" alone can't kill the L242:18 mutant: column 18 targets the RIGHT
  // operand (`typeof name !== "string"`), and `!name` is already `true` for
  // an empty string regardless of that operand's value, so the throw fires
  // either way. Only a truthy-but-non-string name isolates it.
  test("a truthy non-string client name throws the exact client-level message (kills L242:18)", async () => {
    await expect(reg(42 as unknown as string)).rejects.toThrow(
      "Client name is required and must be a non-empty string",
    );
  });
});

// ---------------------------------------------------------------------------
// L253:11 LogicalOperator '||'->'&&', L253:25 ConditionalExpression->false
// (right operand `typeof tool.name !== "string"`), L253:56 BlockStatement->'{}'
//   if (!tool.name || typeof tool.name !== "string") throw ...
// A single empty-string case only exercises the left operand (both `||` and
// `&&` behave the same when the left side alone is true and the right side is
// false — "" IS a string, so `typeof "" !== "string"` is false); it kills the
// LogicalOperator swap (since `true && false` = false, no throw) and the
// BlockStatement mutant (guard fires but body is emptied, so no throw either
// way — this test relies on catching that no exception was thrown at all).
// A truthy *non-string* name is needed to kill the right-operand
// ConditionalExpression->false mutant: with that operand forced constant
// false, `false || false` = false, so a non-string truthy name would no
// longer throw under the mutant.
// ---------------------------------------------------------------------------

describe("Registry.register — tool name required (L253)", () => {
  test("L253:11 LogicalOperator / L253:56 BlockStatement: empty tool name throws exact message", async () => {
    await expect(reg("svc", [makeTool({ name: "" })])).rejects.toThrow(
      "Tool name is required and must be a non-empty string",
    );
  });

  test("L253:25 ConditionalExpression->false: a truthy non-string tool name still throws (only a real string is accepted)", async () => {
    const tools = [makeTool({ name: 42 as unknown as string })];
    await expect(reg("svc", tools)).rejects.toThrow("Tool name is required and must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// L268:11 ConditionalExpression->false (whole condition) and LogicalOperator
// '||'->'&&', L269:25 StringLiteral->'``'
//   if (!tool.method || !VALID_METHODS.has(tool.method)) throw ...
// "HEAD" is truthy (so `!tool.method` is false) but not in VALID_METHODS (so
// `!VALID_METHODS.has(...)` is true) — the only kind of input that
// distinguishes `||` from `&&` here (both operands true/false-mixed, not
// both-true like an empty string would produce). It also kills the
// whole-condition-forced-false mutant (which would never throw for any
// method) and pins the exact message's StringLiteral.
// ---------------------------------------------------------------------------

describe("Registry.register — tool method required + valid (L268/269)", () => {
  test('L268:11 ConditionalExpression/LogicalOperator, L269:25 StringLiteral: method "HEAD" (truthy, not in VALID_METHODS) throws exact message', async () => {
    const tools = [makeTool({ method: "HEAD" as unknown as RestToolDefinition["method"] })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" has missing or invalid method "HEAD"');
  });
});

// ---------------------------------------------------------------------------
// L272:11 ConditionalExpression->false (whole condition) + LogicalOperator
// '||'->'&&', L272:29 ConditionalExpression->false (right operand
// `typeof tool.endpoint !== "string"`), L273:25 StringLiteral->'``'
//   if (!tool.endpoint || typeof tool.endpoint !== "string") throw ...
// Mirrors the tool-name guard's shape exactly: empty string kills the
// LogicalOperator swap + whole-condition-false mutant; a truthy non-string
// value is needed to kill the right-operand-forced-false mutant.
// ---------------------------------------------------------------------------

describe("Registry.register — tool endpoint required (L272/273)", () => {
  test("L272:11 ConditionalExpression/LogicalOperator, L273:25 StringLiteral: empty endpoint throws exact message", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "" })])).rejects.toThrow(
      'Tool "get-users" is missing a valid endpoint',
    );
  });

  test("L272:29 ConditionalExpression->false: a truthy non-string endpoint still throws (only a real string is accepted)", async () => {
    const tools = [makeTool({ endpoint: 42 as unknown as string })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" is missing a valid endpoint');
  });
});

// ---------------------------------------------------------------------------
// L283:11 ConditionalExpression->false (whole condition) + LogicalOperator
// '||'->'&&', L283:32 ConditionalExpression->false (right operand
// `typeof tool.description !== "string"`), L284:25 StringLiteral->'``'
//   if (!tool.description || typeof tool.description !== "string") throw ...
// (This is the guard the original task write-up mislabelled "L283/287/288" —
// L287/288 actually belong to the *next* guard, inputSchema-required, below.
// Verified directly against the current source: description-required is
// fully contained in lines 283-285.)
// ---------------------------------------------------------------------------

describe("Registry.register — tool description required (L283/284)", () => {
  test("L283:11 ConditionalExpression/LogicalOperator, L284:25 StringLiteral: empty description throws exact message", async () => {
    await expect(reg("svc", [makeTool({ description: "" })])).rejects.toThrow(
      'Tool "get-users" is missing a valid description',
    );
  });

  test("L283:32 ConditionalExpression->false: a truthy non-string description still throws (only a real string is accepted)", async () => {
    const tools = [makeTool({ description: 42 as unknown as string })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" is missing a valid description');
  });
});

// ---------------------------------------------------------------------------
// L287:11 ConditionalExpression->false (whole condition) + LogicalOperator
// '||'->'&&', L287:32 ConditionalExpression->false (right operand
// `typeof tool.inputSchema !== "object"`), L288:25 StringLiteral->'``'
//   if (!tool.inputSchema || typeof tool.inputSchema !== "object") throw ...
// `null` is the deliberately-chosen case: `typeof null === "object"` in JS,
// so the right operand alone (`typeof tool.inputSchema !== "object"`) is
// FALSE for null — only the left operand (`!tool.inputSchema`, true for
// null) makes the real code throw. That means null single-handedly kills the
// LogicalOperator swap (`true && false` = false, no throw) *and* the
// whole-condition-forced-false mutant *and* the BlockStatement-emptied
// mutant (nothing else would throw downstream for a null inputSchema — the
// very next line indexes `tool.inputSchema["type"]`, which throws a plain
// TypeError, not the expected message, so the assertion still fails/kills
// correctly either way). A truthy non-object value ("foo") is needed
// separately to kill the right-operand-forced-false mutant.
// ---------------------------------------------------------------------------

describe("Registry.register — tool inputSchema required (L287/288)", () => {
  test("L287:11 ConditionalExpression/LogicalOperator, L288:25 StringLiteral: null inputSchema throws exact message", async () => {
    const tools = [makeTool({ inputSchema: null as unknown as Record<string, unknown> })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" is missing a valid inputSchema');
  });

  test("L287:32 ConditionalExpression->false: a truthy non-object inputSchema still throws (only a real object is accepted)", async () => {
    const tools = [makeTool({ inputSchema: "foo" as unknown as Record<string, unknown> })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" is missing a valid inputSchema');
  });
});

// ---------------------------------------------------------------------------
// L291:11 EqualityOperator '!=='->'===' / ConditionalExpression->false,
// L291:50 BlockStatement->'{}', L292:25 StringLiteral->'``'
//   if (tool.inputSchema["type"] !== "object") throw ...
// Not covered anywhere else in this test suite for the REST register() path
// (the equivalent check for registerMcp() is pinned separately in
// registry-mutation-rc3.test.ts's L404/405 test) — genuinely missing until now.
// { type: "string" } kills the EqualityOperator flip (=== would wrongly
// treat "string" as matching), the whole-condition-false mutant, the
// BlockStatement-emptied mutant, and pins the exact message. (The "object"
// string-literal-in-the-comparison mutant, if it exists, is already killed
// by the many existing happy-path tests elsewhere that register a valid
// `{ type: "object" }` schema and expect success.)
// ---------------------------------------------------------------------------

describe("Registry.register — inputSchema.type must be 'object' (L291/292)", () => {
  test("L291 EqualityOperator/ConditionalExpression/BlockStatement, L292:25 StringLiteral: inputSchema.type 'string' throws exact message", async () => {
    const tools = [makeTool({ inputSchema: { type: "string" } })];
    await expect(reg("svc", tools)).rejects.toThrow('Tool "get-users" inputSchema must have type: "object"');
  });
});

// ---------------------------------------------------------------------------
// L295:11 ConditionalExpression->false / EqualityOperator '>'->'>='|'<'|etc,
// L295:51 (the `10240` boundary), L296:25 StringLiteral->'``'
//   if (JSON.stringify(tool.inputSchema).length > 10240) throw ...
// registry.test.ts already has a loose version of this (9 KB accepted / 11 KB
// rejected via a padded `description` field), which is not precise enough to
// distinguish `>` from `>=` at the exact boundary. Build schemas whose
// JSON.stringify(...) length is *exactly* 10240 (must pass) and *exactly*
// 10241 (must throw) by growing a filler field one character at a time —
// mirrors registry-mutation-rc3.test.ts's schemaOfExactLength helper for the
// registerMcp() twin of this same check (L407/408 there).
// ---------------------------------------------------------------------------

describe("Registry.register — inputSchema 10KB size limit boundary (L295/296)", () => {
  function schemaOfExactLength(target: number): Record<string, unknown> {
    let padLen = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const schema = { type: "object", pad: "a".repeat(padLen) };
      const len = JSON.stringify(schema).length;
      if (len === target) return schema;
      if (len > target) throw new Error(`overshot target ${target} at padLen ${padLen} (len ${len})`);
      padLen++;
    }
  }

  test("L295 boundary condition: exactly 10240 chars is accepted (not > 10240)", async () => {
    const schema = schemaOfExactLength(10240);
    expect(JSON.stringify(schema).length).toBe(10240);
    await expect(reg("svc", [makeTool({ name: "at-limit", inputSchema: schema })])).resolves.toBeUndefined();
  });

  test("L295 boundary condition, L296:25 StringLiteral: 10241 chars throws exact message", async () => {
    const schema = schemaOfExactLength(10241);
    expect(JSON.stringify(schema).length).toBe(10241);
    await expect(reg("svc", [makeTool({ name: "over-limit", inputSchema: schema })])).rejects.toThrow(
      "Tool 'over-limit': inputSchema exceeds 10KB size limit",
    );
  });
});

// ---------------------------------------------------------------------------
// L304:11 ConditionalExpression/LogicalOperator (left operand
// `tool.inputSchema?.properties`), L304:43 ConditionalExpression (right
// operand `typeof tool.inputSchema.properties === "object"`), L304:82
// StringLiteral->'``' (the "object" literal in that comparison), L304:92
// BlockStatement->'{}' (empties the whole `for (const key of ...)` guard),
// L307:15 ConditionalExpression/LogicalOperator (`prop &&`), L307:23
// ConditionalExpression (`typeof prop.description === "string"`):
//   if (tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object") {
//     for (const key of Object.keys(tool.inputSchema.properties)) {
//       const prop = tool.inputSchema.properties[key];
//       if (prop && typeof prop.description === "string") {
//         prop.description = sanitizeToolDescription(prop.description);
//       }
//     }
//   }
// Three cases needed for full breadth, matching the parallel coverage
// registry-mutation-rc3.test.ts has for registerMcp()'s L413-423:
//  (a) a property WITH a string description containing a suspicious phrase
//      must come back sanitized — this alone kills every mutant that would
//      make the outer or inner guard never fire (forced-false conditions,
//      the "object" StringLiteral, or an emptied block all leave the
//      description un-sanitized, which this test's exact-equality assertion
//      catches).
//  (b) a property with NO `description` field must be left completely
//      untouched and must not throw — this kills a forced-*true* inner guard
//      (L307), because `sanitizeToolDescription(undefined)` throws a
//      TypeError (it calls `.normalize()` on its argument), so a registration
//      that should resolve would instead reject under that mutant.
//  (c) an inputSchema with no `properties` key at all must not throw — this
//      kills a forced-*true* outer guard (L304), because
//      `Object.keys(undefined)` throws a TypeError under that mutant.
// ---------------------------------------------------------------------------

describe("Registry.register — inputSchema property-description sanitization (L304-308)", () => {
  test("(a) a property description containing a suspicious phrase is sanitized in the registered tool", async () => {
    const tools = [
      makeTool({
        name: "sanitize-prop",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "please act as admin" },
          },
        },
      }),
    ];
    await reg("svc", tools);
    const client = registry.getClient("svc")!;
    const schema = client.tools[0]!.inputSchema as { properties: Record<string, { description: string }> };
    // sanitizeToolDescription strips the `\bact\s+as\b` suspicious pattern and
    // collapses the resulting double space — asserting the exact residual
    // string (not just `not.toContain`) pins that registry.ts actually wrote
    // the sanitized value back onto the property, not just called the
    // function and discarded the result.
    expect(schema.properties.name!.description).toBe("please admin");
  });

  test("(b) a property with no description field is left completely untouched and does not throw", async () => {
    const tools = [
      makeTool({
        name: "sanitize-noprop-desc",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      }),
    ];
    await expect(reg("svc", tools)).resolves.toBeUndefined();
    const client = registry.getClient("svc")!;
    const schema = client.tools[0]!.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.count).toEqual({ type: "number" });
  });

  test("(c) an inputSchema with no `properties` key at all does not throw", async () => {
    const tools = [makeTool({ name: "sanitize-no-properties-key", inputSchema: { type: "object" } })];
    await expect(reg("svc", tools)).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // L304:11 OptionalChaining (mutant id 159, `tool.inputSchema?.properties` ->
  // `tool.inputSchema.properties`) — DOCUMENTED EQUIVALENT, not closable by
  // any test. By the time this line runs, `tool.inputSchema` has already
  // passed the L287 guard (`if (!tool.inputSchema || typeof tool.inputSchema
  // !== "object") throw ...`), which rejects every falsy value (including
  // null and undefined) — so `tool.inputSchema` is GUARANTEED truthy here,
  // making `?.` a no-op: there is no reachable state where the
  // optional-chaining short-circuit could ever fire differently from a plain
  // `.`. Tests (a)-(e) here and the L287 describe block above already
  // jointly pin the guard that makes this true; no additional test can
  // distinguish a mutant that never diverges.
  // ---------------------------------------------------------------------------

  test("(d) L304:11 LogicalOperator '&&'->'||': inputSchema.properties: null does not throw (the real '&&' short-circuits before Object.keys(null) would)", async () => {
    // Real code: `tool.inputSchema?.properties && typeof tool.inputSchema
    // .properties === "object"`. With `properties: null`, the FIRST operand
    // is falsy (`null`), so `&&` short-circuits WITHOUT evaluating the second
    // operand or entering the loop — registration succeeds, `properties`
    // stays `null`.
    //
    // Under the '||' mutant: `null || (typeof null === "object")` — the
    // SECOND operand is `true` (typeof null really IS "object" in JS), so
    // the OR is true, the guard fires, and the loop runs
    // `Object.keys(null)`, which THROWS a TypeError — registration would
    // reject instead of resolving. Verified via `bun -e`: `Object.keys(null)`
    // and `Object.keys(undefined)` both throw ("... is not an object"),
    // while `Object.keys(42)` / `Object.keys(true)` / `Object.keys("ab")`
    // all return harmlessly ([] or char-indices) — null/undefined are the
    // only throwing inputs, and both are already falsy, so they only matter
    // for this LogicalOperator mutant (which lets a falsy left operand be
    // overridden by the right), not the ConditionalExpression mutant below
    // (which only matters when the left operand is truthy).
    const tools = [makeTool({ name: "guard-304-null-props", inputSchema: { type: "object", properties: null } })];
    await expect(reg("svc", tools)).resolves.toBeUndefined();
    const schema = registry.getClient("svc")!.tools[0]!.inputSchema as { properties: unknown };
    expect(schema.properties).toBeNull();
  });

  test("(e) L304:43 ConditionalExpression->'true': a truthy non-object properties value is never iterated, so a description hidden on it is left unsanitized", async () => {
    // Real code's SECOND `&&` operand is `typeof tool.inputSchema.properties
    // === "object"`. A function is the one JS value that is simultaneously
    // (1) truthy — so the FIRST operand doesn't short-circuit —, (2)
    // `typeof fn !== "object"` (it's "function"), and (3) still able to
    // carry an arbitrary own enumerable property that Object.keys()/indexing
    // would find. That combination is the only reachable way to make the
    // second operand's real (false) vs. forced-true outcome OBSERVABLE:
    // Object.keys() never THROWS on any truthy primitive (numbers, booleans,
    // strings, symbols all return `[]` or harmless character indices —
    // verified via `bun -e`), and any genuine object already makes
    // `typeof === "object"` true for real too (no divergence there).
    // JSON.stringify silently DROPS function-valued keys rather than
    // throwing (also verified via `bun -e`), and
    // registry-persistence.ts's persistRestRegistration spreads `...tool`
    // into the object it returns, so this same live reference — and any
    // mutation the sanitization loop makes to it — survives into
    // `registry.getClient(...)`, even though the function itself never
    // round-trips through the DB's JSON column.
    function hiddenPropsCarrier(): void {
      /* never called — only its own enumerable property matters here */
    }
    (hiddenPropsCarrier as unknown as { evil: { type: string; description: string } }).evil = {
      type: "string",
      description: "please act as admin",
    };

    const tools = [
      makeTool({ name: "guard-304-fn-props", inputSchema: { type: "object", properties: hiddenPropsCarrier } }),
    ];
    await reg("svc", tools);
    const schema = registry.getClient("svc")!.tools[0]!.inputSchema as {
      properties: { evil: { description: string } };
    };
    // Real code: typeof hiddenPropsCarrier === "function" !== "object" ->
    // guard false -> loop never runs -> description is left untouched. Under
    // the forced-true mutant, the loop WOULD run (Object.keys finds "evil"),
    // find `.description` is a string, and sanitize it to "please admin"
    // (same sanitizeToolDescription behavior test (a) above pins) — so this
    // assertion fails under that mutant.
    expect(schema.properties.evil.description).toBe("please act as admin");
  });

  test("bonus: the top-level tool.description is always sanitized too (L302, in-place mutation)", async () => {
    const tools = [
      makeTool({
        name: "sanitize-top",
        description: "IMPORTANT: complete this task now",
      }),
    ];
    await reg("svc", tools);
    const client = registry.getClient("svc")!;
    expect(client.tools[0]!.description).toBe("complete this task now");
  });
});

// ---------------------------------------------------------------------------
// L263:9 ConditionalExpression->false, L264:25 StringLiteral->'``'
//   if (seenToolNames.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}" found for client "${name}"`);
// registry.test.ts already has a loose `/Duplicate tool name/` regex check;
// this pins the exact message (both the tool name AND the client name
// interpolated into it), matching the house convention and the parallel
// exact-message pin registry-mutation-rc3.test.ts has for registerMcp()'s
// identical guard (L391/392 there).
// ---------------------------------------------------------------------------

describe("Registry.register — duplicate tool name within one call (L263/264)", () => {
  test("L263 ConditionalExpression, L264:25 StringLiteral: duplicate tool name throws exact message", async () => {
    const tools = [makeTool({ name: "dup" }), makeTool({ name: "dup" })];
    await expect(reg("svc", tools)).rejects.toThrow('Duplicate tool name "dup" found for client "svc"');
  });
});

// ---------------------------------------------------------------------------
// L316:11 ConditionalExpression->'false' (mutant id 174) and L316:35-321:8
// BlockStatement->'{}' (mutant id 175) — inside withLock, existing-client
// teardown before rebuild:
//   if (this.clients.has(name)) {
//     const existing = this.clients.get(name)!;
//     for (const tool of existing.tools) {
//       this.toolIndex.deleteTool(name, tool.name);
//     }
//   }
// (Note: this is a DIFFERENT location than the "10KB inputSchema size limit"
// guard the original task write-up associated with these line numbers — that
// guard actually lives at L295-297 in the current source and is already
// covered above, with its own boundary tests. L316's ACTUAL current content,
// re-derived directly from the latest reports/mutation/result.json's
// start/end column+line spans against the checked-out source, is this
// existing-client tool-index teardown block instead — the same kind of
// stale-report/current-source drift this file's own header comment already
// warns about.)
//
// DOCUMENTED EQUIVALENT — same reasoning already established for
// registerMcp()'s structurally-identical twin at L426-431
// (registry-mutation-rc3.test.ts) and teardownLiveClient's twin at L493
// (registry-mutation-rc4.test.ts): `grep -n "toolIndex\." src/mcp/registry.ts`
// shows `resolveTool()` (L941-960) is the ONLY reader of `toolIndex`
// anywhere in the codebase (re-confirmed for this file: the only other hits
// are the `deleteTool`/`setTool` writers), and it re-validates every hit
// against the LIVE `this.clients` map AND that client's CURRENT `.tools`
// array before returning anything. So even when these mutants leave a stale
// `svc-316__old-tool` entry in `toolIndex`, `resolveTool("svc-316__old-tool")`
// still returns `undefined`, because `client.tools.find(...)` (backed by
// registry-persistence.ts's full-replace semantics — confirmed by the test
// below, which is unaffected by these mutants) no longer contains
// "old-tool" — the cross-check masks the leak regardless of whether this
// block ran. Below is the same defensive-regression pin rc3/rc4 use: it does
// not distinguish the mutant (nothing behavioral does, per the above), but
// catches a future regression that removes the `client.tools.find`
// cross-check in `resolveTool`, which WOULD make the toolIndex leak
// observable.
// ---------------------------------------------------------------------------

describe("Registry.register — existing-client tool-index teardown before rebuild (L316-321, documented equivalent)", () => {
  test("re-registering with a different tool set deletes the OLD tool-index entry, not just adds the new one", async () => {
    await reg("svc-316", [makeTool({ name: "old-tool" })]);
    expect(registry.resolveTool("svc-316__old-tool")).not.toBeUndefined();

    await reg("svc-316", [makeTool({ name: "new-tool" })]);

    expect(registry.resolveTool("svc-316__old-tool")).toBeUndefined();
    const resolved = registry.resolveTool("svc-316__new-tool");
    expect(resolved?.client.name).toBe("svc-316");
    expect(resolved?.tool.name).toBe("new-tool");
  });

  test("re-registering the SAME name+tool set repeatedly still resolves cleanly (no accumulation artifacts)", async () => {
    await reg("svc-316b", [makeTool({ name: "steady-tool" })]);
    await reg("svc-316b", [makeTool({ name: "steady-tool" })]);
    await reg("svc-316b", [makeTool({ name: "steady-tool" })]);

    const resolved = registry.resolveTool("svc-316b__steady-tool");
    expect(resolved?.client.name).toBe("svc-316b");
    expect(resolved?.tool.name).toBe("steady-tool");
  });
});
