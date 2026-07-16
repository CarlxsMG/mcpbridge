import { describe, expect, test } from "bun:test";
import { looksReDoSProne } from "../guardrails.js";

describe("looksReDoSProne — broadened evil-regex detection (finding #9)", () => {
  test("flags nested unbounded quantifiers (classic shape)", () => {
    expect(looksReDoSProne("(a+)+")).toBe(true);
    expect(looksReDoSProne("(a*)*")).toBe(true);
    expect(looksReDoSProne("(a+)*")).toBe(true);
    expect(looksReDoSProne("(\\w+){2,}")).toBe(true);
    expect(looksReDoSProne("^(\\d+)+$")).toBe(true);
  });

  test("flags {n,}-nested quantifier bodies", () => {
    expect(looksReDoSProne("(a{2,})+")).toBe(true);
    expect(looksReDoSProne("(a{2,5})+")).toBe(true);
    expect(looksReDoSProne("(\\d{1,})*")).toBe(true);
  });

  test("flags quantified groups with overlapping/duplicate alternation branches", () => {
    expect(looksReDoSProne("(a|a)+z")).toBe(true);
    expect(looksReDoSProne("(foo|foo)+X")).toBe(true);
    expect(looksReDoSProne("(foo|foo)*X")).toBe(true);
    expect(looksReDoSProne("([a-z]|[a-z])+9")).toBe(true);
    expect(looksReDoSProne("(ab|ab){2,}")).toBe(true);
  });

  test("does NOT flag benign linear patterns", () => {
    expect(looksReDoSProne("\\bDROP\\s+TABLE\\b")).toBe(false);
    expect(looksReDoSProne("(abc)+")).toBe(false);
    expect(looksReDoSProne("a+")).toBe(false);
    expect(looksReDoSProne("(foo|bar)")).toBe(false);
    expect(looksReDoSProne("(foo|bar)+")).toBe(false);
    expect(looksReDoSProne("\\w+@\\w+")).toBe(false);
  });
});
