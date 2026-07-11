import { describe, expect, test } from "bun:test";

import { canonicalizeValue, stableStringify } from "../stable-json.js";

// ---------------------------------------------------------------------------
// Mutation-testing backstop for `src/lib/stable-json.ts` — deterministic JSON
// serialization (object keys sorted lexicographically at every level, arrays
// left in original order unless an `arrayTransform` is supplied). Pure
// recursive logic, no I/O. Security-sensitive: `stableStringify`'s output is
// hashed for `approvalArgsHash` (persisted, must stay byte-stable), so this
// suite pins the exact serialized strings, not just loose shape assertions.
// ---------------------------------------------------------------------------

describe("canonicalizeValue", () => {
  test("returns primitives unchanged", () => {
    expect(canonicalizeValue("hello")).toBe("hello");
    expect(canonicalizeValue(42)).toBe(42);
    expect(canonicalizeValue(true)).toBe(true);
    expect(canonicalizeValue(false)).toBe(false);
    expect(canonicalizeValue(undefined)).toBe(undefined);
  });

  test("returns null unchanged (does not enter the object branch)", () => {
    // typeof null === "object", so the `value !== null` guard is load-bearing:
    // if it were dropped, this would attempt Object.keys(null) and throw.
    expect(canonicalizeValue(null)).toBe(null);
  });

  test("sorts object keys lexicographically at the top level", () => {
    const result = canonicalizeValue({ b: 1, a: 2, c: 3 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ a: 2, b: 1, c: 3 });
  });

  test("sorts keys deeply at every nested object level", () => {
    const input = { z: { y: 1, x: 2 }, a: 1 };
    const result = canonicalizeValue(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(Object.keys(result.z as Record<string, unknown>)).toEqual(["x", "y"]);
  });

  test("recurses into array elements but preserves array element order (no transform)", () => {
    const input = [{ b: 1, a: 2 }, { d: 1, c: 2 }, 3, "str"];
    const result = canonicalizeValue(input) as unknown[];
    expect(result).toEqual([{ a: 2, b: 1 }, { c: 2, d: 1 }, 3, "str"]);
    expect(Object.keys(result[0] as Record<string, unknown>)).toEqual(["a", "b"]);
  });

  test("empty array and empty object canonicalize to themselves", () => {
    expect(canonicalizeValue([])).toEqual([]);
    expect(canonicalizeValue({})).toEqual({});
  });

  test("without arrayTransform, arrays are returned as-is (order preserved)", () => {
    const result = canonicalizeValue([3, 1, 2]) as unknown[];
    expect(result).toEqual([3, 1, 2]);
  });

  test("with arrayTransform, the transform's return value wins over the mapped array", () => {
    const reverseTransform = (arr: unknown[]): unknown[] => [...arr].reverse();
    const result = canonicalizeValue([1, 2, 3], reverseTransform);
    expect(result).toEqual([3, 2, 1]);
  });

  test("arrayTransform runs bottom-up: inner arrays are transformed before the outer one, and object keys inside are still sorted", () => {
    const sortByName = (arr: unknown[]): unknown[] =>
      [...arr].sort((a, b) => {
        const an = (a as { name?: unknown }).name;
        const bn = (b as { name?: unknown }).name;
        if (typeof an === "string" && typeof bn === "string") return an.localeCompare(bn);
        return 0;
      });

    const input = [
      { name: "outer-b", tags: [{ name: "z" }, { name: "a" }] },
      { name: "outer-a", z: 1, a: 2 },
    ];
    const result = canonicalizeValue(input, sortByName) as Array<Record<string, unknown>>;

    // Outer array sorted by name.
    expect(result.map((x) => x.name)).toEqual(["outer-a", "outer-b"]);
    // The element that used to be first (outer-b) keeps its own key order sorted.
    const outerB = result.find((x) => x.name === "outer-b") as Record<string, unknown>;
    expect(Object.keys(outerB)).toEqual(["name", "tags"]);
    // Its nested `tags` array was itself transformed (sorted by name) bottom-up.
    expect((outerB.tags as Array<{ name: string }>).map((t) => t.name)).toEqual(["a", "z"]);
    // The element with plain data keys (outer-a) still has those keys sorted.
    const outerA = result.find((x) => x.name === "outer-a") as Record<string, unknown>;
    expect(Object.keys(outerA)).toEqual(["a", "name", "z"]);
  });

  test("arrayTransform is not invoked when omitted, even for nested arrays (no TypeError)", () => {
    // If the ternary's false branch were mutated to always call arrayTransform(arr),
    // this would throw because arrayTransform is undefined and not callable.
    expect(() =>
      canonicalizeValue([
        [1, 2],
        [3, 4],
      ]),
    ).not.toThrow();
    expect(
      canonicalizeValue([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("stableStringify", () => {
  test("serializes primitives exactly like JSON.stringify", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(false)).toBe("false");
  });

  test("serializes null as the literal string 'null'", () => {
    expect(stableStringify(null)).toBe("null");
  });

  test("serializes bare undefined as 'null' (unlike JSON.stringify, which returns undefined)", () => {
    expect(stableStringify(undefined)).toBe("null");
    expect(JSON.stringify(undefined)).toBeUndefined();
  });

  test("serializes an object's undefined-valued property as null rather than dropping it", () => {
    // Contrast with native JSON.stringify, which drops undefined-valued keys.
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"a":null,"b":1}');
    expect(JSON.stringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  test("sorts object keys lexicographically regardless of insertion order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: 1, m: 2, a: 3 })).toBe('{"a":3,"m":2,"z":1}');
  });

  test("sorts keys deeply in nested objects", () => {
    expect(stableStringify({ z: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  test("serializes arrays preserving element order, comma-separated", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("serializes an empty array and empty object", () => {
    expect(stableStringify([])).toBe("[]");
    expect(stableStringify({})).toBe("{}");
  });

  test("serializes an array of objects, sorting each object's keys but not reordering the array", () => {
    const input = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    expect(stableStringify(input)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  test("two structurally-equal objects built with different key insertion order produce identical strings (stability guarantee)", () => {
    const first = { name: "x", id: 1, tags: ["b", "a"] };
    const second = { tags: ["b", "a"], id: 1, name: "x" };
    expect(stableStringify(first)).toBe(stableStringify(second));
  });

  test("key strings are JSON-escaped like a normal JSON key", () => {
    expect(stableStringify({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });
});
