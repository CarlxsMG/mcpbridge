/**
 * Stryker mutation-testing backstop for src/lib/mcp-result.ts.
 *
 * No prior test file existed for this module. `toolResult()` is a single
 * pure builder with one ternary branch (isError vs. success) and two nested
 * object/array literals — small, but every literal and the conditional both
 * need direct coverage since Stryker mutates object literals to `{}`, array
 * literals to `[]`, the `"text"` string literal to `""`, the `isError: true`
 * boolean literal to `false`, and the ternary condition to forced
 * true/false.
 */
import { describe, test, expect } from "bun:test";
import { toolResult } from "../mcp-result.js";
import type { ToolCallResult } from "../mcp-result.js";

describe("toolResult — success path (no opts / isError omitted or falsy)", () => {
  test("called with no second argument at all produces a bare content envelope", () => {
    const result = toolResult("hello world");
    expect(result).toEqual({ content: [{ type: "text", text: "hello world" }] });
    // Guard against a mutant that adds `isError: undefined` (would pass a
    // plain toEqual but must not actually be a present key).
    expect(Object.hasOwn(result, "isError")).toBe(false);
  });

  test("called with an explicit empty opts object behaves identically to omitting it", () => {
    const result = toolResult("second", {});
    expect(result).toEqual({ content: [{ type: "text", text: "second" }] });
    expect(Object.hasOwn(result, "isError")).toBe(false);
  });

  test("opts.isError explicitly false still omits the isError key (not just falsy-equal)", () => {
    const result = toolResult("third", { isError: false });
    expect(result).toEqual({ content: [{ type: "text", text: "third" }] });
    expect(Object.hasOwn(result, "isError")).toBe(false);
  });

  test("content array has exactly one text part with the exact input text and type", () => {
    const result = toolResult("exact-text-value");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("exact-text-value");
  });

  test("empty-string text is passed through unchanged (not coerced/dropped)", () => {
    const result = toolResult("");
    expect(result).toEqual({ content: [{ type: "text", text: "" }] });
  });
});

describe("toolResult — error path (opts.isError: true)", () => {
  test("sets isError to true (not merely truthy) alongside the content envelope", () => {
    const result: ToolCallResult = toolResult("boom", { isError: true });
    expect(result.isError).toBe(true);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "boom" }] });
  });

  test("content shape in the error branch matches the success branch's shape exactly", () => {
    const result = toolResult("failure detail", { isError: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("failure detail");
  });

  test("a distinct text value in the error branch proves `text` isn't hardcoded/swapped", () => {
    const first = toolResult("alpha", { isError: true });
    const second = toolResult("beta", { isError: true });
    expect(first.content[0]!.text).toBe("alpha");
    expect(second.content[0]!.text).toBe("beta");
    expect(first.content[0]!.text).not.toBe(second.content[0]!.text);
  });
});

describe("toolResult — the two branches are genuinely distinguishable", () => {
  test("the same text with isError true vs. false/omitted produces different envelopes", () => {
    const ok = toolResult("shared text");
    const err = toolResult("shared text", { isError: true });
    expect(Object.hasOwn(ok, "isError")).toBe(false);
    expect(err.isError).toBe(true);
    expect(ok).not.toEqual(err);
    // Both still carry the identical text through untouched.
    expect(ok.content[0]!.text).toBe(err.content[0]!.text);
  });
});
