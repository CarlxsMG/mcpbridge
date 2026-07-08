/**
 * Targeted mutation-kill tests for `truncateToBudget` (src/tool-policies/context-budget.ts).
 * Written against three concrete Stryker survivors from a prior run (see
 * HANDOFF_P2-3.md-style task description) — this file exists purely to close
 * those gaps, not to re-cover ground already owned by context-budget.test.ts's
 * "truncateToBudget (pure)" describe block.
 *
 * Survivors targeted:
 *   1. `full.length <= maxBytes` (EqualityOperator: `<=` -> `<`) — the
 *      "exactly at budget" boundary.
 *   2. `let kept = ""` (StringLiteral: injected junk) — only observable when
 *      the while loop never assigns `kept`, i.e. `end` starts at (or backs
 *      all the way off to) 0.
 *   3. `while (end > 0)` (EqualityOperator: `>` -> `>=`).
 *
 * On (3): this mutant is EQUIVALENT — documented below with the empirical
 * reasoning, no forced/contrived test written against it.
 *
 * Reasoning: `end` only reaches 0 in two ways —
 *   (a) `maxBytes <= 0`, so `end = Math.max(0, maxBytes)` starts at 0 and the
 *       real loop (`end > 0`) never executes even once, leaving `kept` at its
 *       initial `""`.
 *   (b) every candidate boundary from the initial `end` down to 1 lands
 *       mid-UTF-8-sequence, so the `catch` branch runs repeatedly
 *       (`end--`) until `end` hits 0; the real loop then exits via
 *       `end > 0` being false, again leaving `kept` at its initial `""`
 *       (it was never successfully assigned — every attempt threw).
 *
 * In both cases, under the real `>` code, `kept` is `""` and `end` is `0`
 * when the loop finishes. Under the `>=` mutant, the loop runs exactly one
 * extra iteration with `end === 0`: `strictUtf8Decoder.decode(full.subarray(0, 0))`
 * decodes a zero-length slice, which is *always* valid UTF-8 and *always*
 * decodes to `""` (never throws) — so `kept` gets reassigned to `""` (a
 * no-op, since it already was `""`) and the loop `break`s instead of exiting
 * via the false condition. Since the extra iteration always succeeds
 * immediately, it never runs `end--`, so `end` is unchanged at `0` either
 * way. Every observable field (`text`, `truncated`, `originalBytes`,
 * `keptBytes`) ends up byte-for-byte identical.
 *
 * This was verified empirically (not just argued): a standalone script ran
 * both the real (`>`) and mutant (`>=`) loop bodies side by side against
 * text/maxBytes pairs specifically chosen to hit both routes to `end === 0`
 * above — pure-ASCII with `maxBytes: 0`, empty string with `maxBytes: 0`,
 * and all-multi-byte strings (`"é".repeat(n)`, `"😀".repeat(n)`, including
 * 4-byte surrogate-pair codepoints) at `maxBytes` values of 1, 2, and 3 that
 * force the backoff loop to collapse all the way down to `end === 0`. Every
 * pair produced identical `{ text, truncated, originalBytes, keptBytes }`
 * output. There is no reachable input that distinguishes `>` from `>=` here.
 */
import { describe, test, expect } from "bun:test";
import { truncateToBudget } from "../../tool-policies/context-budget.js";

describe("truncateToBudget (pure) — mutation-kill: <=, kept initializer, >/>= boundary", () => {
  test("text exactly at the byte budget (full.length === maxBytes) is NOT truncated", () => {
    // "12345" is 5 plain-ASCII bytes; maxBytes is exactly 5.
    // Real code (`<=`): 5 <= 5 is true -> returns unchanged, truncated: false.
    // Mutant (`<`): 5 < 5 is false -> would incorrectly fall through to truncation.
    const text = "12345";
    const result = truncateToBudget(text, 5);
    expect(result).toEqual({ text: "12345", truncated: false, originalBytes: 5, keptBytes: 5 });
  });

  test("maxBytes = 0 never enters the backoff loop, so `kept` keeps its real initial value ('', not injected junk)", () => {
    // end = Math.max(0, 0) = 0, so `while (end > 0)` never runs a single
    // iteration under real code — `kept` is whatever it was initialized to.
    // Real code: kept = "" -> result.text is just the marker, unprefixed.
    // Mutant (StringLiteral on the initializer): kept = "Stryker was here!"
    // -> result.text would start with that injected junk instead.
    const result = truncateToBudget("0123456789", 0);
    expect(result.truncated).toBe(true);
    expect(result.keptBytes).toBe(0);
    expect(result.text.startsWith("\n\n[context-budget: response truncated")).toBe(true);
    expect(result.text).not.toContain("Stryker was here!");
  });

  // `end > 0` vs `end >= 0` (mutant): see the file-header comment above for
  // the full empirical equivalence argument. No test is written against this
  // mutant — it is not observably killable. The two regression-style probes
  // below are kept only to document (and pin, in case this analysis is ever
  // revisited) that both routes to `end === 0` produce ordinary, correct
  // output under the real implementation.
  test("all-multi-byte text backed all the way off to end=0 still truncates cleanly (documents the >/>= equivalence route)", () => {
    // "é" is 2 bytes each; maxBytes=1 lands mid-sequence on the very first
    // character, forcing the backoff loop to collapse end: 1 -> 0.
    const result = truncateToBudget("é".repeat(5), 1);
    expect(result.truncated).toBe(true);
    expect(result.keptBytes).toBe(0);
    expect(result.originalBytes).toBe(10);
    expect(result.text.startsWith("\n\n[context-budget: response truncated")).toBe(true);
  });

  test("maxBytes = 0 against a 4-byte-codepoint string also lands cleanly at end=0 (documents the >/>= equivalence route)", () => {
    // "😀" is a 4-byte UTF-8 surrogate-pair codepoint; maxBytes=0 takes the
    // "never enters the loop at all" route rather than the backoff route.
    const result = truncateToBudget("😀😀😀", 0);
    expect(result.truncated).toBe(true);
    expect(result.keptBytes).toBe(0);
    expect(result.originalBytes).toBe(12);
    expect(result.text.startsWith("\n\n[context-budget: response truncated")).toBe(true);
  });
});
