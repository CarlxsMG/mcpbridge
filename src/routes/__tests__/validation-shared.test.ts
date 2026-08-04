/**
 * The two validators in src/routes/validation.ts that replaced per-file copies.
 *
 * Both exist because several route files had grown near-identical helpers whose
 * differences were real but easy to miss on a read — an integer requirement
 * here, a positive-only rule there, a length cap in one of two otherwise
 * identical tools[] checks. Now that the differences are OPTIONS, these tests
 * are what stop a caller from silently inheriting the wrong rule: each case
 * below pins one option's effect, and the "no options" cases pin the defaults
 * every caller gets when they pass nothing.
 */
import { describe, test, expect } from "bun:test";
import { optNumberOrNull, parseToolRefs, MAX_GUARD_TIMEOUT_MS } from "../validation.js";

describe("optNumberOrNull", () => {
  test("undefined and null both mean 'clear it'", () => {
    expect(optNumberOrNull(undefined)).toEqual({ ok: true, value: null });
    expect(optNumberOrNull(null)).toEqual({ ok: true, value: null });
  });

  test("with no options, any finite number passes — including zero and negatives", () => {
    // alerts.ts relies on this: a threshold of 0 or a negative delta is meaningful.
    expect(optNumberOrNull(0)).toEqual({ ok: true, value: 0 });
    expect(optNumberOrNull(-5)).toEqual({ ok: true, value: -5 });
    expect(optNumberOrNull(1.5)).toEqual({ ok: true, value: 1.5 });
  });

  test("non-numbers and non-finite numbers are rejected", () => {
    for (const bad of ["3", true, {}, [], NaN, Infinity, -Infinity]) {
      expect(optNumberOrNull(bad).ok).toBe(false);
    }
  });

  test("integer: true rejects a fractional value", () => {
    expect(optNumberOrNull(10, { integer: true })).toEqual({ ok: true, value: 10 });
    expect(optNumberOrNull(10.5, { integer: true }).ok).toBe(false);
  });

  test("min excludes values below it — the quota rule (positive integers only)", () => {
    expect(optNumberOrNull(1, { integer: true, min: 1 })).toEqual({ ok: true, value: 1 });
    expect(optNumberOrNull(0, { integer: true, min: 1 }).ok).toBe(false);
    expect(optNumberOrNull(-1, { integer: true, min: 1 }).ok).toBe(false);
  });

  test("max excludes values above it — the guard-timeout ceiling", () => {
    expect(optNumberOrNull(MAX_GUARD_TIMEOUT_MS, { max: MAX_GUARD_TIMEOUT_MS }).ok).toBe(true);
    expect(optNumberOrNull(MAX_GUARD_TIMEOUT_MS + 1, { max: MAX_GUARD_TIMEOUT_MS }).ok).toBe(false);
  });

  test("min: Number.MIN_VALUE is how 'strictly positive' is spelled, and it excludes 0", () => {
    // policies.ts's rateLimitPerMin/timeoutMs use this: a positive number, and 0
    // is not one. A plain `min: 0` would have quietly allowed it.
    expect(optNumberOrNull(0, { min: Number.MIN_VALUE }).ok).toBe(false);
    expect(optNumberOrNull(0.5, { min: Number.MIN_VALUE })).toEqual({ ok: true, value: 0.5 });
  });
});

describe("parseToolRefs", () => {
  test("accepts a well-formed tools[] array", () => {
    expect(parseToolRefs([{ client: "billing", tool: "charge" }])).toEqual({
      ok: true,
      value: [{ client: "billing", tool: "charge" }],
    });
  });

  test("an empty array is valid — clearing a policy's tool list is a real operation", () => {
    expect(parseToolRefs([])).toEqual({ ok: true, value: [] });
  });

  test("rejects a non-array with a message naming the field", () => {
    const result = parseToolRefs({ client: "billing", tool: "charge" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("tools");
  });

  test.each([
    ["missing tool", { client: "billing" }],
    ["missing client", { tool: "charge" }],
    ["empty client", { client: "", tool: "charge" }],
    ["empty tool", { client: "billing", tool: "" }],
    ["wrong types", { client: 1, tool: 2 }],
    ["null entry", null],
    ["string entry", "billing__charge"],
  ])("rejects an entry with %s", (_label, entry) => {
    expect(parseToolRefs([entry]).ok).toBe(false);
  });

  test("max caps the array length, and is not applied when omitted", () => {
    const refs = [
      { client: "a", tool: "x" },
      { client: "b", tool: "y" },
    ];
    expect(parseToolRefs(refs, { max: 2 }).ok).toBe(true);
    const capped = parseToolRefs(refs, { max: 1 });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.message).toContain("1");
    // policies.ts passes no cap on purpose — a policy's tools[] is bounded by
    // what exists, not by the per-client tool limit.
    expect(parseToolRefs(refs).ok).toBe(true);
  });

  test("stops at the first bad entry rather than reporting only the last", () => {
    const result = parseToolRefs([{ client: "ok", tool: "ok" }, { client: 1 }, { client: 2 }]);
    expect(result.ok).toBe(false);
  });
});
