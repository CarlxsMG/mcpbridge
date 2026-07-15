/**
 * Shared object dot-path helpers: read/write semantics (empty path, nested,
 * arrays, missing) and — critically — the prototype-pollution guard that makes
 * this the single safe implementation behind tool transforms, redaction,
 * pagination, and composite templating.
 */
import { describe, test, expect } from "bun:test";
import { getByPath, setByPath, removeByPath, isUnsafeSegment, hasUnsafeSegment } from "../object-path.js";

describe("getByPath", () => {
  test("empty path returns the root unchanged", () => {
    const root = { a: 1 };
    expect(getByPath(root, "")).toBe(root);
    expect(getByPath([1, 2], "")).toEqual([1, 2]);
  });

  test("walks nested objects", () => {
    expect(getByPath({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
  });

  test("missing keys and a null/primitive intermediate yield undefined (no throw)", () => {
    expect(getByPath({ a: 1 }, "x.y")).toBeUndefined();
    expect(getByPath({ a: null }, "a.b")).toBeUndefined();
    expect(getByPath({ a: 5 }, "a.b")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
  });

  test("array steps require an integer index", () => {
    expect(getByPath({ items: [{ name: "x" }, { name: "y" }] }, "items.1.name")).toBe("y");
    expect(getByPath({ items: [1, 2] }, "items.foo")).toBeUndefined();
    expect(getByPath({ items: [1, 2] }, "items.length")).toBeUndefined();
  });
});

describe("setByPath", () => {
  test("creates intermediate objects", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "a.b.c", 7);
    expect(obj).toEqual({ a: { b: { c: 7 } } });
  });

  test("replaces a non-object or array intermediate with a fresh object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    setByPath(obj, "a.b", 2);
    expect(obj).toEqual({ a: { b: 2 } });

    const arr: Record<string, unknown> = { a: [1, 2] };
    setByPath(arr, "a.b", 3);
    expect(arr).toEqual({ a: { b: 3 } });
  });

  test("overwrites an existing leaf", () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    setByPath(obj, "a.b", 9);
    expect(obj.a).toEqual({ b: 9 });
  });
});

describe("removeByPath", () => {
  test("deletes a leaf", () => {
    const obj: Record<string, unknown> = { a: { b: 1, c: 2 } };
    removeByPath(obj, "a.b");
    expect(obj).toEqual({ a: { c: 2 } });
  });

  test("a missing path is a no-op", () => {
    const obj: Record<string, unknown> = { a: 1 };
    removeByPath(obj, "x.y.z");
    expect(obj).toEqual({ a: 1 });
  });
});

describe("segment classification", () => {
  test("isUnsafeSegment flags the prototype-chain segments only", () => {
    for (const s of ["__proto__", "constructor", "prototype"]) expect(isUnsafeSegment(s)).toBe(true);
    for (const s of ["a", "proto", "__proto", "constructORD", ""]) expect(isUnsafeSegment(s)).toBe(false);
  });

  test("hasUnsafeSegment inspects every segment of a dot-path", () => {
    expect(hasUnsafeSegment("a.b.c")).toBe(false);
    expect(hasUnsafeSegment("a.__proto__.c")).toBe(true);
    expect(hasUnsafeSegment("constructor")).toBe(true);
    expect(hasUnsafeSegment("a.prototype")).toBe(true);
  });
});

describe("prototype-pollution guard", () => {
  // A shared sentinel: if any writer leaks into Object.prototype these read back
  // as non-undefined on an unrelated fresh object.
  const clean = (): boolean =>
    (({}) as Record<string, unknown>).polluted === undefined &&
    ({} as Record<string, unknown>).hacked === undefined &&
    typeof Object.prototype.hasOwnProperty === "function";

  test("getByPath refuses to traverse a prototype segment", () => {
    expect(getByPath({}, "__proto__")).toBeUndefined();
    expect(getByPath({}, "__proto__.polluted")).toBeUndefined();
    expect(getByPath({ a: {} }, "a.constructor.prototype")).toBeUndefined();
  });

  test("setByPath cannot reach Object.prototype", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "__proto__.polluted", "yes");
    setByPath(obj, "constructor.prototype.hacked", "yes");
    expect(obj).toEqual({});
    expect(clean()).toBe(true);
  });

  test("removeByPath cannot reach Object.prototype", () => {
    // hasOwnProperty is an own prop of Object.prototype — a naive walk would
    // delete it. The guard must make this a no-op.
    removeByPath({} as Record<string, unknown>, "__proto__.hasOwnProperty");
    expect(clean()).toBe(true);
    expect(typeof ({} as Record<string, unknown>).hasOwnProperty).toBe("function");
  });
});
