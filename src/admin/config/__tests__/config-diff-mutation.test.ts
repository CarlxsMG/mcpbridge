/**
 * Stryker mutation-testing backstop for `diffConfigs` (src/admin/config/config-diff.ts).
 *
 * Pure, dependency-free logic (only imports `lib/stable-json.ts`'s
 * `canonicalizeValue`, itself out of this mutation-testing scope) — no DB, no
 * registry, no Express harness needed. Every test calls the real exported
 * `diffConfigs` directly and asserts on its exact return value.
 */
import { describe, test, expect } from "bun:test";
import { diffConfigs } from "../config-diff.js";

describe("diffConfigs — equality short-circuit", () => {
  test("identical primitives (===) produce no diff", () => {
    expect(diffConfigs(5, 5)).toEqual([]);
    expect(diffConfigs("same", "same")).toEqual([]);
  });

  test("NaN vs NaN at a nested path collapses to no diff via the JSON.stringify shortcut", () => {
    // a !== b is true for NaN (strict-equality never holds for NaN), but both
    // sides are non-objects whose JSON.stringify representations ("null")
    // are equal, so walk()'s secondary equality check must also short-circuit.
    expect(diffConfigs({ v: NaN }, { v: NaN })).toEqual([]);
  });
});

describe("diffConfigs — root-level primitive diff", () => {
  test("a changed root value falls back to the (root) path label", () => {
    expect(diffConfigs(1, 2)).toEqual([{ path: "(root)", kind: "changed", before: 1, after: 2 }]);
  });
});

describe("diffConfigs — added / removed / changed classification with dotted paths", () => {
  test("a new top-level key is classified as added", () => {
    expect(diffConfigs({}, { x: 5 })).toEqual([{ path: "x", kind: "added", before: undefined, after: 5 }]);
  });

  test("a deeply nested removed leaf uses a dotted path", () => {
    const a = { outer: { inner: { deep: 1 } } };
    const b = { outer: { inner: {} } };
    expect(diffConfigs(a, b)).toEqual([{ path: "outer.inner.deep", kind: "removed", before: 1, after: undefined }]);
  });

  test("a changed nested leaf uses a dotted path", () => {
    const a = { outer: { inner: 5 } };
    const b = { outer: { inner: 6 } };
    expect(diffConfigs(a, b)).toEqual([{ path: "outer.inner", kind: "changed", before: 5, after: 6 }]);
  });

  test("a whole added object (non-object counterpart is undefined) is reported as one entry, not recursed into", () => {
    const a = { config: {} };
    const b = { config: { obj: { name: "z" } } };
    expect(diffConfigs(a, b)).toEqual([{ path: "config.obj", kind: "added", before: undefined, after: { name: "z" } }]);
  });

  test("a whole removed object (other side undefined) is reported as one entry, not recursed into", () => {
    const a = { config: { obj: { name: "z" } } };
    const b = { config: {} };
    expect(diffConfigs(a, b)).toEqual([
      { path: "config.obj", kind: "removed", before: { name: "z" }, after: undefined },
    ]);
  });

  test("a null leaf vs. a real object is a 'changed' diff, not a crash — aIsObj's own null guard", () => {
    // typeof null === "object" in JS, so aIsObj's `a !== null` guard is load
    // bearing: without it, a null value would be misclassified as an object
    // and the code would fall through to Object.keys(null), which throws.
    expect(diffConfigs({ x: null }, { x: { y: 1 } })).toEqual([
      { path: "x", kind: "changed", before: null, after: { y: 1 } },
    ]);
  });

  test("a real object vs. a null leaf is a 'changed' diff, not a crash — bIsObj's own null guard", () => {
    expect(diffConfigs({ x: { y: 1 } }, { x: null })).toEqual([
      { path: "x", kind: "changed", before: { y: 1 }, after: null },
    ]);
  });
});

describe("diffConfigs — canonicalization: object key order never produces spurious diffs", () => {
  test("reordered object keys diff empty", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(diffConfigs(a, b)).toEqual([]);
  });
});

describe("diffConfigs — canonicalization: name-bearing arrays are order-insensitive", () => {
  test("a reordered array of name-bearing objects diffs empty", () => {
    const a = {
      clients: [
        { name: "b", enabled: true },
        { name: "a", enabled: true },
      ],
    };
    const b = {
      clients: [
        { name: "a", enabled: true },
        { name: "b", enabled: true },
      ],
    };
    expect(diffConfigs(a, b)).toEqual([]);
  });

  test("a reordered array of name-bearing objects still detects a real leaf change, aligned by name", () => {
    const a = {
      clients: [
        { name: "b", enabled: true },
        { name: "a", enabled: true },
      ],
    };
    const b = {
      clients: [
        { name: "a", enabled: false },
        { name: "b", enabled: true },
      ],
    };
    // Sorted by name, "a" lands at index 0 on both sides, so the diff must
    // land at clients.0.enabled specifically — not clients.1, and not a
    // spurious name-mismatch at index 0 (which an unsorted/naive index
    // comparison would produce instead).
    expect(diffConfigs(a, b)).toEqual([{ path: "clients.0.enabled", kind: "changed", before: true, after: false }]);
  });

  test("sort direction (ascending by name) is load-bearing, not just 'some sort'", () => {
    // a, sorted ascending: [{name:"a"}, {name:"b"}]
    // b, sorted ascending: [{name:"a"}, {name:"b"}, {name:"c"}]
    // If the comparator were reversed (descending) both sides would still
    // resort consistently, but the *added* element ("c") would no longer
    // land at the tail relative to a matched "a"/"b" pair the same way —
    // a reversed comparator produces a completely different (and larger)
    // diff (name-mismatches at indices 0/1 plus the addition), not this
    // single clean "added" entry at the end.
    const a = { tools: [{ name: "b" }, { name: "a" }] };
    const b = { tools: [{ name: "c" }, { name: "a" }, { name: "b" }] };
    expect(diffConfigs(a, b)).toEqual([{ path: "tools.2", kind: "added", before: undefined, after: { name: "c" } }]);
  });

  test("an empty array diffs empty against another empty array (length guard boundary)", () => {
    expect(diffConfigs({ list: [] }, { list: [] })).toEqual([]);
  });
});

describe("diffConfigs — canonicalization: arrays WITHOUT a name on every element are left in original order", () => {
  test("a reordered array of plain numbers is treated positionally (order matters)", () => {
    const a = { list: [1, 2] };
    const b = { list: [2, 1] };
    expect(diffConfigs(a, b)).toEqual([
      { path: "list.0", kind: "changed", before: 1, after: 2 },
      { path: "list.1", kind: "changed", before: 2, after: 1 },
    ]);
  });

  test("an array where only SOME elements carry a name is not sorted (every() must fail, not some())", () => {
    const a = { list: [{ name: "x" }, { other: 1 }] };
    const b = { list: [{ other: 1 }, { name: "x" }] };
    // Not every element has "name", so canonicalize must leave both arrays
    // in their literal (unsorted) order — a naive fix that sorted whenever
    // ANY element had a name would wrongly align these and report no diff.
    expect(diffConfigs(a, b)).toEqual([
      { path: "list.0.name", kind: "removed", before: "x", after: undefined },
      { path: "list.0.other", kind: "added", before: undefined, after: 1 },
      { path: "list.1.other", kind: "removed", before: 1, after: undefined },
      { path: "list.1.name", kind: "added", before: undefined, after: "x" },
    ]);
  });

  test("a null element in an array does not crash the name-detection guard, and blocks sorting", () => {
    // "name" in null throws a TypeError, so the `x !== null` guard must
    // short-circuit before the `typeof`/`in` checks ever run on a null
    // element. Same fixture on both sides also proves no spurious diff.
    const a = { list: [null, { name: "z" }] };
    const b = { list: [null, { name: "z" }] };
    expect(() => diffConfigs(a, b)).not.toThrow();
    expect(diffConfigs(a, b)).toEqual([]);
  });
});
