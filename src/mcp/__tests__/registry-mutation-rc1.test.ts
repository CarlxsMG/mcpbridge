import { describe, test, expect, beforeEach } from "bun:test";

// Stryker mutation backstop — RC1 (registry.ts lines 1-230): VALID_METHODS,
// validateEndpointPath, and the start of the Registry class (getClient,
// listClients, markClientStatus, incrementConsecutiveFailures,
// resetConsecutiveFailures, isServable, resolveAdvertisedName,
// isAliasAvailable). Each test/comment cites the exact line:column, mutator,
// and replacement it kills, per the house convention established across the
// P2 mutation-testing series (see reports/mutation/result.json).
//
// Harness pattern matches the sibling file registry.test.ts.

import { registry, validateEndpointPath, ToolOverrideError } from "../../mcp/registry.js";
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
// L79:39 StringLiteral -> '""' — VALID_METHODS = new Set(["GET","POST","PUT",
// "PATCH","DELETE"]). GET is covered by makeTool()'s default and POST is
// exercised widely elsewhere in registry.test.ts, but PUT/PATCH/DELETE are
// not pinned per-literal anywhere in this suite. Any one of those three
// string literals turned into "" would make VALID_METHODS.has(tool.method)
// reject that real HTTP method. Register one tool per method (including GET
// and POST for completeness) and assert registration succeeds — this kills
// the mutant no matter which literal in the Set it lands on.
// ---------------------------------------------------------------------------

describe("VALID_METHODS — L79:39 StringLiteral -> ''", () => {
  test.each(["GET", "POST", "PUT", "PATCH", "DELETE"] as const)("accepts a tool with method %s", async (method) => {
    await expect(reg("svc", [makeTool({ method })])).resolves.toBeUndefined();
    expect(registry.resolveTool("svc__get-users")?.tool.method).toBe(method);
  });
});

// ---------------------------------------------------------------------------
// L88:17 StringLiteral -> '""' — ToolOverrideError's constructor:
//   this.name = "ToolOverrideError";
// Trigger a REAL ToolOverrideError (via setToolOverride with an
// invalid-charset displayName — same trigger registry-mutation-rc6.test.ts
// uses for its TOOL_ALIAS_INVALID coverage) and pin the caught error's
// `.name` to the exact string. `class ToolOverrideError extends Error`
// already defaults `.name` to the inherited "Error" without this line, so an
// emptied-string mutant wouldn't produce an *obviously* broken error — it
// would silently leave `.name` at the Error-default "Error" instead of
// "ToolOverrideError". That matters because callers elsewhere could branch
// on (or log/display) `error.name`, so it's worth pinning the exact value
// rather than treating it as a no-op mutation.
// ---------------------------------------------------------------------------

describe("ToolOverrideError — L88:17 StringLiteral -> ''", () => {
  test("a thrown ToolOverrideError has .name exactly 'ToolOverrideError'", async () => {
    await reg("svc-override-name", [makeTool({ name: "tool-a" })]);
    let caught: unknown;
    try {
      await registry.setToolOverride("svc-override-name", "tool-a", { displayName: "Bad Name!" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolOverrideError);
    expect((caught as Error).name).toBe("ToolOverrideError");
  });
});

// ---------------------------------------------------------------------------
// validateEndpointPath — L110:34 Regex -> '/:[^A-Za-z_][A-Za-z0-9_]*/g'
// (negates the character class in the :param placeholder substitution) and
// L112:34 StringLiteral -> '""' (the ".." literal in the traversal check).
// ---------------------------------------------------------------------------

describe("validateEndpointPath — L110:34 Regex -> '/:[^A-Za-z_][A-Za-z0-9_]*/g' (negated placeholder class)", () => {
  test("':..b' segment is rejected under the correct regex but wrongly accepted under the negated-class mutant", () => {
    // The real regex /:[A-Za-z_][A-Za-z0-9_]*/g requires the char right after
    // ':' to be a letter/underscore — so it never matches ":..b" (first char
    // after ':' is '.'), leaving the segment ":..b" completely untouched.
    // ":..b" literally contains "..", so the traversal check correctly flags
    // it (non-null).
    //
    // Under the mutated regex /:[^A-Za-z_][A-Za-z0-9_]*/g, the negated class
    // DOES match ':' followed by '.' (a non-letter), consuming exactly ":."
    // and substituting it with "x" — turning ":..b" into "x.b", which no
    // longer equals ".."/"." or contains "..", so the mutant wrongly returns
    // null (accepted). Empirically verified via a standalone bun script
    // reproducing both regexes side-by-side before writing this test.
    expect(validateEndpointPath("/a/:..b")).not.toBeNull();
  });

  test("baseline: a real :id placeholder followed by a genuine '..' traversal segment is still rejected", () => {
    expect(validateEndpointPath("/users/:id/../admin")).not.toBeNull();
  });

  test("baseline: a clean :param-only endpoint is valid", () => {
    expect(validateEndpointPath("/users/:id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateEndpointPath — L110:34 Regex -> '/:[A-Za-z_][^A-Za-z0-9_]*/g'.
// This is a DIFFERENT mutant variant than the one above: that one negates
// the FIRST character class (the char right after ':'); this one negates the
// SECOND character class (the placeholder's tail), i.e.
// `/:[A-Za-z_][^A-Za-z0-9_]*/g` instead of `/:[A-Za-z_][A-Za-z0-9_]*/g`.
// ---------------------------------------------------------------------------

describe("validateEndpointPath — L110:34 Regex -> '/:[A-Za-z_][^A-Za-z0-9_]*/g' (negated SECOND placeholder class)", () => {
  test("':a..b' segment: real regex consumes only ':a' (leaving literal '..b', invalid); the negated-second-class mutant consumes ':a..' instead (leaving 'b', wrongly valid)", () => {
    // Real regex /:[A-Za-z_][A-Za-z0-9_]*/g: the character right after the
    // matched 'a' is '.', which is NOT in [A-Za-z0-9_], so the second class
    // matches zero characters — the whole match is just ":a". Substituting
    // "x" for that turns ":a..b" into "x..b", which contains ".." and is
    // correctly flagged invalid.
    //
    // Mutant regex /:[A-Za-z_][^A-Za-z0-9_]*/g: the second class is negated,
    // so it greedily matches the two NON-alnum/underscore dots ('..')
    // immediately after 'a', stopping only at the alnum 'b' — the whole
    // match becomes ":a..". Substituting "x" for THAT turns ":a..b" into
    // "xb", which no longer contains ".." — wrongly accepted (returns null).
    //
    // Empirically verified via a standalone `bun` script comparing both
    // regexes side by side on this and several other inputs (including
    // "/users/:id" and "/a/:id2/:another_one", which do NOT diverge — the
    // divergence specifically needs a literal ".." immediately following the
    // placeholder's leading letter) before writing this test.
    expect(validateEndpointPath("/x/:a..b")).not.toBeNull();
  });
});

describe("validateEndpointPath — L110:62 StringLiteral -> '' (the \"x\" placeholder-substitution literal)", () => {
  test("two placeholders separated only by a literal '.' stay valid — the substitution must leave a non-empty 'x' behind, not vanish", () => {
    // Real code: endpoint.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "x") turns
    // ":a.:b" into "x.x" — three characters, not exactly "." — valid.
    //
    // Mutant (replacement -> ""): ":a.:b" becomes just "." (both placeholders
    // vanish, leaving only the literal dot between them) — which IS exactly
    // "." and gets wrongly flagged as an invalid path segment.
    //
    // Verified empirically via a standalone `bun` script comparing "x" vs ""
    // substitution across several inputs — a lone placeholder segment
    // (":id" alone) does NOT diverge (its "" result is filtered out by the
    // adjacent `.filter(Boolean)` either way), so the divergence specifically
    // needs a placeholder immediately adjacent to a literal "." with nothing
    // else in that path segment.
    expect(validateEndpointPath("/a/:a.:b/c")).toBeNull();
  });
});

describe("validateEndpointPath — L112:34 StringLiteral -> '' in '..' traversal-segment check", () => {
  test("a segment that IS exactly '..' is flagged", () => {
    expect(validateEndpointPath("/users/../admin")).not.toBeNull();
  });

  test("a segment that merely CONTAINS '..' (e.g. 'a..b') is flagged by the .includes('..') arm, independent of the === '..' literal", () => {
    // This exercises s.includes("..") rather than s === "..", so it survives
    // even if the === ".." comparison's literal were mutated to "" (since
    // "" === "" would be vacuously satisfied by an empty segment, not this
    // one) — included here for completeness of the OR chain.
    expect(validateEndpointPath("/files/a..b")).not.toBeNull();
  });

  test("a segment that is NOT exactly '..' and does NOT contain '..' is valid — distinguishes the '..' literal from an empty-string mutant", () => {
    // If L112's ".." literal were mutated to "", the check becomes
    // `s === "" || s === "." || s.includes("")`. Since s.includes("") is
    // TRUE for every string, every segment would be flagged as invalid —
    // including a perfectly normal one like "admin". This test would fail
    // under that mutant because "admin" would wrongly be rejected.
    expect(validateEndpointPath("/users/admin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L112:28 ConditionalExpression->'false' (mutant id 24, forces the isolated
// `s === ".."` comparison to always be false) and L112:34 StringLiteral->'""'
// (mutant id 26, changes ONLY that same comparison's ".." literal to "" —
// i.e. `s === ""`; NOT the separate ".." literal a little further along the
// same line inside `s.includes("..")`, which is a different AST node and is
// already killed by the tests above) — both DOCUMENTED EQUIVALENT, not
// closable by any test. Proof:
//
//   predicate(s) = s === ".." || s === "." || s.includes("..")
//
// Every segment `s` that reaches this predicate is guaranteed non-empty,
// because it comes from `probe.split("/").filter(Boolean)` a few lines up —
// `filter(Boolean)` drops every "" entry, so `s === ""` (id 26's mutated
// form) can NEVER be true for any reachable segment: id 26 is unreachable.
// And whenever the REAL `s === ".."` holds, `s` literally IS the
// two-character string "..", so `s.includes("..")` (a string trivially
// contains itself) is ALSO true, unconditionally — meaning forcing the
// first disjunct to `false` (id 24) never changes the OR chain's result,
// since the third disjunct already covers every case the first one would
// have covered. Verified two ways: (1) the case analysis above, and (2)
// empirically — a `bun` script constructing the real predicate and both
// mutated forms (`s === ".." || s === "." || s.includes("..")`,
// `false || s === "." || s.includes("..")`, and
// `s === "" || s === "." || s.includes("..")`) and diffing their outputs
// across a curated input list AND a 200,000-string exhaustive-alphabet fuzz
// (`/`, `.`, `a`, `b` up to length 6, plus a random 200k-string fuzz over a
// wider `/ . a b : _ 2` alphabet through the FULL `validateEndpointPath`
// function) found zero divergences in either direction.
//
// The two describe blocks above already pin the intended (real) behavior at
// this line (a "..", a mixed "a..b", and a clean "admin" segment), so no
// additional test is added here — per the P2-3/PX series convention (see
// stryker.config.mjs's SCOPE HISTORY and registry-mutation-rc3.test.ts's
// L426 block), a proven-equivalent mutant is documented rather than padded
// with a test that provably cannot distinguish it.
//
// L111:20 MethodExpression -> 'probe.split("/")' (drops the trailing
// `.filter(Boolean)`) is DOCUMENTED EQUIVALENT for the exact same reason:
// the only thing `.filter(Boolean)` removes from `segments` is empty-string
// entries (from a leading/trailing/doubled "/"), and an empty string can
// never satisfy `s === ".." || s === "." || s.includes("..")` — so whether
// those "" entries are present or absent in the array, `.some(...)`'s
// result is identical either way. Verified empirically via a `bun -e`
// script comparing filtered vs. unfiltered segments across leading/
// trailing/doubled-slash inputs ("/a/b/", "//a//b//", "a/../b", "/../", "",
// "/"): zero divergences.
// ---------------------------------------------------------------------------

describe("Registry.register — endpoint validation integration (extra pin for L110/L112)", () => {
  test("rejects registration when endpoint has a literal '..' segment mixed with a real :param", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/:id/../secret" })])).rejects.toThrow(/invalid path segment/i);
  });

  test("accepts registration for a :param-only endpoint with an ordinary trailing segment", async () => {
    await expect(reg("svc", [makeTool({ endpoint: "/users/:id/profile" })])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L161:9 ConditionalExpression -> 'true' in markClientStatus:
//   if (client) { client.status = status; }
// Forcing the guard to always-true would try to write `.status` onto
// `undefined` for an unknown client name, throwing a TypeError.
// ---------------------------------------------------------------------------

describe("Registry.markClientStatus — L161:9 ConditionalExpression -> 'true'", () => {
  test("calling markClientStatus for a non-existent client is a safe no-op (does not throw)", () => {
    expect(() => registry.markClientStatus("does-not-exist", "healthy")).not.toThrow();
  });

  test("calling markClientStatus for an existing client actually updates its status", async () => {
    await reg("svc");
    registry.markClientStatus("svc", "unreachable");
    expect(registry.getClient("svc")?.status).toBe("unreachable");
  });
});

// ---------------------------------------------------------------------------
// incrementConsecutiveFailures — L170:54 BlockStatement -> '{}' and L172:9
// (BooleanLiteral -> 'client', ConditionalExpression -> true/false) in:
//   if (!client) return 0;
//   client.consecutive_failures += 1;
//   return client.consecutive_failures;
// Test both branches: unknown client returns exactly 0 (no throw), known
// client's counter increments by exactly 1 per call.
// ---------------------------------------------------------------------------

describe("Registry.incrementConsecutiveFailures — L170/L172 guard + increment", () => {
  test("returns exactly 0 for an unknown client and does not throw", () => {
    expect(registry.incrementConsecutiveFailures("nobody")).toBe(0);
  });

  test("increments a known client's counter by exactly 1 per call (1, then 2)", async () => {
    await reg("svc");
    expect(registry.getClient("svc")?.consecutive_failures).toBe(0);
    expect(registry.incrementConsecutiveFailures("svc")).toBe(1);
    expect(registry.incrementConsecutiveFailures("svc")).toBe(2);
    expect(registry.getClient("svc")?.consecutive_failures).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resetConsecutiveFailures — L178:48 BlockStatement -> '{}', L180:9
// ConditionalExpression -> false, L180:17 BlockStatement -> '{}' in:
//   if (client) { client.consecutive_failures = 0; }
// ---------------------------------------------------------------------------

describe("Registry.resetConsecutiveFailures — L178/L180 guard + reset", () => {
  test("resets a known client's failure counter back to exactly 0 after it was incremented", async () => {
    await reg("svc");
    registry.incrementConsecutiveFailures("svc");
    registry.incrementConsecutiveFailures("svc");
    expect(registry.getClient("svc")!.consecutive_failures).toBe(2);

    registry.resetConsecutiveFailures("svc");
    expect(registry.getClient("svc")!.consecutive_failures).toBe(0);
  });

  test("calling resetConsecutiveFailures on an unknown client does not throw", () => {
    expect(() => registry.resetConsecutiveFailures("does-not-exist")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isAliasAvailable(clientName, toolName, displayName) — L216-227.
//   if (displayName === toolName) return true;
//   ... DB query joining tools/tool_overrides ...
//   for (const r of rows) {
//     if (r.name === displayName || r.display_name === displayName) return false;
//   }
//   return true;
// Needs real breadth: (a) short-circuit true, (b) collision with another
// tool's own name, (c) collision with another tool's existing displayName
// override, (d) genuinely free displayName.
// ---------------------------------------------------------------------------

describe("Registry.isAliasAvailable — L216-227 breadth", () => {
  test("(a) displayName === toolName short-circuits to true without needing the client/tool to even be registered", () => {
    // No registration at all — if the early-return mutated away, this would
    // fall through to the DB query and (with no rows) still return true, so
    // pair this with (b)/(c)/(d) below which require the query to actually run.
    expect(registry.isAliasAvailable("nope", "self-tool", "self-tool")).toBe(true);
  });

  test("(b) aliasing to another tool's own real name is rejected — r.name === displayName branch", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    // tool-b wants to alias itself to "tool-a", which is tool-a's real name.
    expect(registry.isAliasAvailable("svc", "tool-b", "tool-a")).toBe(false);
  });

  test("(c) aliasing to another tool's existing displayName override is rejected — r.display_name === displayName branch", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" }), makeTool({ name: "tool-c" })]);
    // tool-a is aliased to "shiny-name" via setToolOverride.
    const ok = await registry.setToolOverride("svc", "tool-a", { displayName: "shiny-name" });
    expect(ok).toBe(true);

    // tool-c now tries to claim "shiny-name" too — must be rejected even
    // though "shiny-name" is not any tool's *real* name (only tool-a's alias).
    expect(registry.isAliasAvailable("svc", "tool-c", "shiny-name")).toBe(false);
  });

  test("(d) a genuinely free displayName (no real-name or alias collision) is available", async () => {
    await reg("svc", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    expect(registry.isAliasAvailable("svc", "tool-b", "totally-unused-name")).toBe(true);
  });

  test("(e) collision check is scoped per-client — same displayName taken on a different client does not block this client", async () => {
    await reg("svc-one", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await reg("svc-two", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);

    const ok = await registry.setToolOverride("svc-one", "tool-a", { displayName: "shared-name" });
    expect(ok).toBe(true);

    // svc-two's tool-b claiming "shared-name" must be unaffected by svc-one's alias.
    expect(registry.isAliasAvailable("svc-two", "tool-b", "shared-name")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (f) L216:9 ConditionalExpression -> 'false' — `if (displayName ===
  // toolName) return true;`. Test (a) above calls isAliasAvailable for a
  // client that was NEVER registered, which does NOT distinguish this
  // mutant: if the early return is bypassed, the DB query runs against a
  // nonexistent client, finds zero rows, and ALSO returns true by falling
  // through the empty for-loop — same observable result either way. A
  // genuine distinguishing setup needs the fallback DB query to find a
  // REAL colliding row if (and only if) the early return is skipped.
  //
  // Setup: register two tools, then alias one of them (tool-c) to
  // "shared-alias" — a string that is NOT any tool's real name, only
  // tool-c's alias. Now call isAliasAvailable(client, "shared-alias",
  // "shared-alias") — toolName and displayName are equal, so the real
  // early return fires unconditionally and returns true. If forced false,
  // the query's `t.name != 'shared-alias'` exclusion filter excludes
  // NOTHING (no real tool is named "shared-alias"), so it returns BOTH
  // tool-b's and tool-c's rows — and tool-c's own display_name ===
  // "shared-alias" collides with the very displayName being checked,
  // wrongly returning false. This makes the two code paths diverge
  // observably, without touching registry.ts.
  // -------------------------------------------------------------------------
  test("(f) L216:9 ConditionalExpression->false: displayName===toolName short-circuit is load-bearing, not a query-fallback coincidence", async () => {
    await reg("svc-216", [makeTool({ name: "tool-b" }), makeTool({ name: "tool-c" })]);
    const ok = await registry.setToolOverride("svc-216", "tool-c", { displayName: "shared-alias" });
    expect(ok).toBe(true);

    expect(registry.isAliasAvailable("svc-216", "shared-alias", "shared-alias")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getClient / listClients — light sanity coverage so any stray mutation to
// these trivial accessors (already well covered by registry.test.ts, but
// pinned here too since they're in this file's declared scope) is caught
// within this file's own run.
// ---------------------------------------------------------------------------

describe("Registry.getClient / listClients — in-scope accessor sanity", () => {
  test("getClient returns undefined for an unregistered name", () => {
    expect(registry.getClient("ghost")).toBeUndefined();
  });

  test("listClients reflects exactly the currently registered clients", async () => {
    expect(registry.listClients()).toHaveLength(0);
    await reg("svc-a");
    await reg("svc-b");
    const names = registry
      .listClients()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["svc-a", "svc-b"]);
  });
});
