import { describe, test, expect } from "bun:test";
import { mapStringLeaves } from "../walk-strings.js";

const upper = (s: string): string => s.toUpperCase();

describe("mapStringLeaves", () => {
  test("transforms a bare string", () => {
    expect(mapStringLeaves("hi", upper)).toBe("HI");
  });

  test("returns non-string primitives unchanged (number/boolean/null/undefined)", () => {
    // These hit the fall-through `return value` — a primitive leaf reached while
    // walking (e.g. a numeric structuredContent field) must pass through as-is.
    expect(mapStringLeaves(3, upper)).toBe(3);
    expect(mapStringLeaves(true, upper)).toBe(true);
    expect(mapStringLeaves(null, upper)).toBeNull();
    expect(mapStringLeaves(undefined, upper)).toBeUndefined();
  });

  test("maps every string leaf of a nested object + array, leaving non-strings intact", () => {
    const out = mapStringLeaves({ a: "x", n: 1, b: { c: "y", ok: true }, arr: ["z", 2] }, upper);
    expect(out).toEqual({ a: "X", n: 1, b: { c: "Y", ok: true }, arr: ["Z", 2] });
  });

  test("skipKeys copies the matching key's value verbatim (never transformed or recursed)", () => {
    const out = mapStringLeaves(
      { type: "resource_link", uri: "leak", data: "AAAA", nested: { keep: "deep" } },
      upper,
      new Set(["type", "data"]),
    );
    // type + data are skipped (verbatim); uri and the nested string ARE transformed.
    expect(out).toEqual({ type: "resource_link", uri: "LEAK", data: "AAAA", nested: { keep: "DEEP" } });
  });

  test("does not mutate the input (returns a new value)", () => {
    const input = { a: "x" };
    const out = mapStringLeaves(input, upper) as { a: string };
    expect(out).not.toBe(input);
    expect(input.a).toBe("x");
    expect(out.a).toBe("X");
  });

  test("is prototype-pollution safe: an untrusted __proto__ own key stays a plain own property", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": "ok"}') as Record<string, unknown>;
    const out = mapStringLeaves(evil, upper) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.safe).toBe("OK");
  });
});
