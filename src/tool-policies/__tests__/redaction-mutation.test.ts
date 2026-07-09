/**
 * Stryker mutation-testing backstop for src/content-filtering/redaction.ts.
 * Baseline 69.44% (50/72) — the existing redaction.test.ts covers top-level/
 * nested-path redaction, wildcard over ARRAY elements (both leaf and nested),
 * missing-path no-ops, non-JSON input, store CRUD, proxy integration, and the
 * admin route — but never exercises wildcard over OBJECT keys (the entire
 * `else` branch of the wildcard handler), a named segment applied to an array
 * intermediate, a missing LEAF key on an otherwise-present intermediate,
 * setRedactionPaths' trim/filter-empty pipeline, or a genuine DELETE-vs-empty-
 * UPSERT distinction when clearing.
 *
 * 11:7-11:28 ConditionalExpression [Survived] false (`segments.length === 0`
 * forced false) is a DOCUMENTED EQUIVALENT — `String.prototype.split` never
 * returns a 0-length array for any input (verified via `bun -e` across
 * `""`, `"."`, `"a"`, `"a.b"`, `".."`, `"a."`), and both recursive call sites
 * only ever pass `rest` when `rest.length !== 0` (the sibling `if
 * (rest.length === 0)` branch handles the zero case directly, without
 * recursing) — so `segments.length === 0` can never be true via any reachable
 * call path in this codebase.
 *
 * 15:9-15:28 ConditionalExpression [Survived] false (`Array.isArray(node)`
 * forced false, in the wildcard handler) is a DOCUMENTED EQUIVALENT — data
 * only ever enters this function via `JSON.parse`, so every array reaching
 * it is dense with only numeric-string own-enumerable keys; iterating via
 * `Object.keys(array)` (the mutant's fallback object-branch) visits the
 * identical indices in the identical ascending order as the array-specific
 * `for (let i = 0; i < node.length; i++)` loop, producing byte-identical
 * output for any JSON-sourced array. Verified via `bun -e` simulation
 * comparing both iteration strategies directly.
 *
 * 34:14-34:37 ConditionalExpression [Survived] true (`obj[head] !== undefined`
 * forced true, in the named-segment leaf/recurse branch) is a DOCUMENTED
 * EQUIVALENT — recursing into a genuinely-missing property passes `undefined`
 * as `node`, which immediately hits this function's OWN top guard
 * (`typeof node !== "object"` is true for `undefined`) and returns with zero
 * side effects — identical to not recursing at all. JSON has no `undefined`
 * literal, so a property can only be present-with-a-real-value or absent;
 * there is no third state to distinguish. Verified via `bun -e`.
 *
 * 16:23-16:38 EqualityOperator [Timeout] (`i < node.length` -> `i <=
 * node.length`) and 16:40-16:43 UpdateOperator [Timeout] (`i++` -> `i--`) are
 * both GENUINE INFINITE LOOPS, already detected by the pre-existing
 * `redaction.test.ts`'s own "wildcard leaf redacts each array element" test
 * (no new test needed): `<=` combined with `node[i] = ...` auto-growing a
 * real array on out-of-bounds write means `node.length` keeps receding away
 * from `i`, and `i--` makes `i` count away from `node.length` forever in the
 * opposite direction. Same "detected via timeout" convention used throughout
 * this program.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb } from "../../db/connection.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { applyRedaction, setRedactionPaths, getRedactionPaths } from "../../content-filtering/redaction.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const TOOL = "get-users";
function makeTool(): RestToolDefinition {
  return {
    name: TOOL,
    method: "GET",
    endpoint: "/users",
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register(
    CLIENT,
    [makeTool()],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

// 11:7-11:73 (whole guard, both ConditionalExpression-forced-false and the
// outer/inner LogicalOperator swaps) — an intermediate value that is `null`
// isolates the `node === null` half. `typeof null === "object"` in JS, so
// forcing the FIRST sub-condition (segments.length===0) away doesn't affect
// this case; only the guard's `node===null` and combined forms matter here.
describe("redactInPlace — a null intermediate value is a no-op, not a crash", () => {
  test("a path through a null intermediate leaves the document unchanged", () => {
    const out = applyRedaction(["a.b"], JSON.stringify({ a: null }));
    expect(JSON.parse(out!)).toEqual({ a: null });
  });
});

// Same guard cluster, isolating the `typeof node !== "object"` half via a
// non-null PRIMITIVE intermediate. A NUMBER intermediate with a non-numeric
// leaf (e.g. "a.b" against {a:5}) does NOT distinguish real from mutant —
// `hasOwnProperty.call(5, "b")` is false either way, so bypassing the guard
// still silently no-ops (verified empirically; an earlier version of this
// test used exactly that combination and it failed to kill the mutant). A
// STRING intermediate with a NUMERIC-STRING leaf is required instead:
// strings expose their character indices as real own properties
// (`hasOwnProperty.call("hello","0")` is true), so bypassing the guard
// reaches a real assignment attempt on an immutable string primitive,
// which throws in strict-mode ESM (confirmed via a standalone script) —
// the real guard's early return never lets that assignment happen at all.
describe("redactInPlace — a primitive (non-object) intermediate value is a no-op, not a crash", () => {
  test("a path through a string intermediate with a numeric-looking leaf does not throw", () => {
    expect(() => applyRedaction(["a.0"], JSON.stringify({ a: "hello" }))).not.toThrow();
    const out = applyRedaction(["a.0"], JSON.stringify({ a: "hello" }));
    expect(JSON.parse(out!)).toEqual({ a: "hello" });
  });
});

// 15:9-15:28 ConditionalExpression [Survived] true (Array.isArray forced
// true, even for a genuine object), 20:12-26:6 BlockStatement [Survived]
// (the whole object-wildcard else-branch emptied), 22:41-25:8 BlockStatement
// [Survived] (its for-loop body emptied), 23:13-23:30 cluster [Survived]
// (rest.length===0 leaf-vs-recurse branch, forced both ways + `===`->`!==`).
// No existing test ever wildcards over OBJECT keys (only arrays) — this is
// the leaf case (rest.length === 0 after consuming the wildcard segment).
describe("applyRedaction — wildcard over OBJECT keys (leaf), not just array elements", () => {
  test("meta.* redacts every key of an object, not a no-op", () => {
    const out = applyRedaction(["meta.*"], JSON.stringify({ meta: { a: "1", b: "2" }, other: "x" }));
    const data = JSON.parse(out!);
    expect(data.meta).toEqual({ a: "[REDACTED]", b: "[REDACTED]" });
    expect(data.other).toBe("x");
  });
});

// Same object-wildcard cluster, isolating the NESTED (rest.length !== 0)
// branch — proves the wildcard descends into each object value rather than
// replacing it wholesale.
describe("applyRedaction — wildcard over OBJECT keys (nested), preserving sibling fields", () => {
  test("items.*.secret redacts only .secret on each object value, not the whole value", () => {
    const out = applyRedaction(
      ["items.*.secret"],
      JSON.stringify({ items: { x: { secret: "a", id: 1 }, y: { secret: "b", id: 2 } } }),
    );
    const data = JSON.parse(out!);
    expect(data.items.x.secret).toBe("[REDACTED]");
    expect(data.items.x.id).toBe(1);
    expect(data.items.y.secret).toBe("[REDACTED]");
    expect(data.items.y.id).toBe(2);
  });
});

// 30:7-30:26 ConditionalExpression [Survived] false ("a named segment can't
// index an array" guard, forced false). A NUMERIC-STRING named segment
// (as opposed to "*") is the only realistic way to observe this: a real
// array's own `hasOwnProperty("0")` is true, so bypassing the guard would
// actually redact element 0 — something the real code deliberately never
// does for a non-wildcard segment.
describe("redactInPlace — a named (non-wildcard) segment never indexes into an array", () => {
  test("items.0 does not redact array element 0", () => {
    const out = applyRedaction(["items.0"], JSON.stringify({ items: ["a", "b"] }));
    expect(JSON.parse(out!)).toEqual({ items: ["a", "b"] });
  });
});

// 33:13-33:56 ConditionalExpression [Survived] true (`hasOwnProperty` forced
// true). The existing "missing paths are a no-op" test only reaches the
// EARLIER `obj[head] !== undefined` guard (L34) with a missing INTERMEDIATE
// key, never reaching L33 at all. A missing LEAF key on an otherwise-present
// intermediate is needed to isolate L33 specifically — forcing it true would
// fabricate a brand-new property that was never there.
describe("redactInPlace — a missing LEAF key on a present intermediate stays absent", () => {
  test("user.missing does not create a new 'missing' property", () => {
    const out = applyRedaction(["user.missing"], JSON.stringify({ user: { name: "x" } }));
    expect(JSON.parse(out!)).toEqual({ user: { name: "x" } });
  });
});

// 65:29-65:71 MethodExpression [Survived] (`.filter(Boolean)` dropped from
// the trim/dedup/filter chain) and 65:46-65:54 MethodExpression [Survived]
// (`.trim()` dropped). One test with both whitespace-needing-trim and
// empty/whitespace-only entries kills both at once.
describe("setRedactionPaths — trims whitespace and drops empty entries", () => {
  test("whitespace is trimmed and blank entries are filtered out", async () => {
    await reg();
    setRedactionPaths(CLIENT, TOOL, [" password ", "", "   ", "email"]);
    expect(getRedactionPaths(CLIENT, TOOL)).toEqual(["password", "email"]);
  });
});

// 66:7-66:25 ConditionalExpression [Survived] false (`clean.length === 0`
// forced false). getRedactionPaths returns [] whether the row is genuinely
// DELETED or merely upserted with an empty paths_json array, so the friendly
// getter alone can't distinguish them — verify the row is actually GONE via
// direct SQL, the same technique established for guardrails.ts's
// getGuardrails()===null / genuine-DELETE distinction.
describe("setRedactionPaths — clearing genuinely deletes the row, not an empty upsert", () => {
  test("an all-blank paths array deletes the row entirely", async () => {
    await reg();
    setRedactionPaths(CLIENT, TOOL, ["password"]);
    setRedactionPaths(CLIENT, TOOL, ["", "   "]);
    const row = getDb()
      .query(`SELECT COUNT(*) as c FROM tool_redactions WHERE client_name = ? AND tool_name = ?`)
      .get(CLIENT, TOOL) as { c: number };
    expect(row.c).toBe(0);
  });
});
