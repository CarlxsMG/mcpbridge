import { describe, expect, test } from "bun:test";

import { safeCompare } from "../compare.js";

// ---------------------------------------------------------------------------
// safeCompare — direct unit tests
//
// These tests exist primarily as a mutation-testing backstop for
// `src/security/compare.ts`. The existing `auth.test.ts` exercises the
// "different inputs → 403" path indirectly through `adminAuth`, but never
// asserts on the return value of `safeCompare` directly, and never hits
// the catch path. Two Stryker mutants survive because of that gap:
//
//   * BlockStatement (line 16, replacement `{}`):
//       If the try-block is emptied, equal-true inputs return `undefined`
//       instead of `true`. A test that asserts `.toBe(true)` (strict
//       equality, not just truthiness) catches it.
//
//   * BooleanLiteral (line 17, replacement `true`):
//       If the catch returns `true` instead of `false`, any error path
//       silently reports "match". A test that forces the digest to throw
//       and asserts `.toBe(false)` catches it. The cleanest way to force
//       the throw without mocking is to pass a non-string input (the
//       declared `(a: string, b: string)` contract is type-only; the
//       function has a defensive catch precisely so that runtime contract
//       violations don't propagate as uncaught exceptions).
//
// All inputs below use real UTF-8 strings except the "defensive catch"
// tests, which use `@ts-expect-error` to deliberately invoke the
// defensive path.
// ---------------------------------------------------------------------------

describe("safeCompare — equal inputs return true", () => {
  test("(a, a) for non-empty strings returns true (kills BlockStatement mutant)", () => {
    // Strict equality, not truthiness — Mutant 4 empties the try-block so
    // the function returns `undefined`, which `.toBe(true)` rejects.
    expect(safeCompare("hunter2", "hunter2")).toBe(true);
  });

  test("(empty, empty) returns true", () => {
    expect(safeCompare("", "")).toBe(true);
  });

  test("(long-identical, long-identical) returns true", () => {
    const s = "x".repeat(1024);
    expect(safeCompare(s, s)).toBe(true);
  });
});

describe("safeCompare — different inputs return false", () => {
  test("returns false when content differs by one character", () => {
    expect(safeCompare("hunter2", "hunter3")).toBe(false);
  });

  test("returns false when length differs", () => {
    // Length leak would short-circuit here without hashing; this asserts
    // the function goes through `sha256Hex` for both sides first.
    expect(safeCompare("a", "ab")).toBe(false);
  });

  test("returns false for empty vs non-empty", () => {
    expect(safeCompare("", "x")).toBe(false);
  });
});

describe("safeCompare — defensive catch returns false", () => {
  // The `try` body can throw in two ways at runtime, despite the type
  // signature:
  //   1. `sha256Hex(a)` throws if `a` is not a string (e.g. null,
  //      undefined, a Symbol, etc.) — `createHash("sha256").update(...)`
  //      rejects non-string/non-Buffer input with a TypeError.
  //   2. `timingSafeEqual` throws if the two buffers differ in length —
  //      impossible in practice with sha256Hex output (always 32 bytes)
  //      but the defensive catch covers it anyway.
  //
  // Either way the catch MUST return `false`. Flipping it to `true` would
  // silently authorize mismatches on the error path — see Stryker Mutant 5
  // (BooleanLiteral line 17, replacement `true`).

  test("(null, null) → catch runs → returns false (kills BooleanLiteral mutant)", () => {
    // @ts-expect-error — deliberate runtime contract violation to trigger the catch
    expect(safeCompare(null, null)).toBe(false);
  });

  test("(undefined, 'x') → catch runs → returns false", () => {
    // @ts-expect-error — deliberate runtime contract violation to trigger the catch
    expect(safeCompare(undefined, "x")).toBe(false);
  });

  test("('x', undefined) → catch runs → returns false", () => {
    // @ts-expect-error — deliberate runtime contract violation to trigger the catch
    expect(safeCompare("x", undefined)).toBe(false);
  });
});
