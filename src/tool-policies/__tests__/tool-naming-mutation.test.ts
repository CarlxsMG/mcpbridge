/**
 * Stryker mutation-testing backstop for src/discovery/tool-naming.ts.
 * Baseline 67.65% (23/34) — the existing tool-naming.test.ts covers
 * camelCase splitting, single-invalid-char replacement, the empty/all-
 * invalid fallback, a basic 100-char truncation length check, a single
 * collision suffix, and the max-length-termination regressions — but never
 * multiple CONSECUTIVE invalid characters (only ever one at a time), never
 * multiple leading non-underscore invalid characters, never the EXACT
 * truncated value (only its length), and never a SECOND sequential
 * collision on the same base name.
 *
 * 33:10-33:62 LogicalOperator [Survived] (`&&` -> `||`), 33:42-33:62
 * EqualityOperator [Survived] (`>` -> `>=`), and 33:42-33:62
 * ConditionalExpression [Survived] true (all on
 * `TOOL_NAME_RE.test(truncated) && truncated.length > 0`) are DOCUMENTED
 * EQUIVALENTS. `TOOL_NAME_RE` is `/^[a-z0-9][a-z0-9_-]{0,62}$/` — matching
 * it REQUIRES at least one character (the mandatory leading class), so
 * `truncated.length > 0` is implied whenever the regex matches. The only
 * way for `truncated.length > 0` to be true while the regex FAILS would be
 * a truncated string that's non-empty but doesn't match the pattern — but
 * every value truncated can actually take here comes from steps 27-31,
 * which guarantee it's composed ENTIRELY of `[a-z0-9_-]` characters and (if
 * non-empty) starts with `[a-z0-9]` and is capped to `MAX_LEN` (63) chars —
 * exactly what `TOOL_NAME_RE` requires. Verified via `bun -e` brute-forcing
 * a wide variety of inputs (empty, all-punctuation, unicode, very long,
 * mixed hyphen/underscore) through the REAL (unmutated) pipeline: no
 * non-empty `truncated` value ever failed `TOOL_NAME_RE`. Both mutant
 * directions of the `&&`/`>`-vs-`>=` swap are therefore unobservable via
 * any input reachable through this function's own internal call chain.
 *
 * 52:6-55:4 BlockStatement [Timeout] (uniqueToolName's do-while body
 * emptied), 53:23-53:37 StringLiteral [Timeout] (the `` `_${suffix++}` ``
 * template emptied — `suffix` then never increments, so `candidate` never
 * changes and the already-colliding `name` loops forever), and 54:17-54:83
 * ArithmeticOperator [Timeout] (`+` -> `-`, coercing the concatenation to
 * `NaN`, which a `Set` treats as equal to itself once added, hanging on any
 * SECOND collision) are all GENUINE INFINITE LOOPS, already detected by the
 * pre-existing "keeps disambiguating across many collisions" regression
 * test (no new test needed) — same "detected via timeout" convention used
 * throughout this program.
 */
import { describe, test, expect } from "bun:test";
import { sanitizeToolName, uniqueToolName } from "../../discovery/tool-naming.js";

// 30:14-30:19 Regex [Survived] `/_/g` (the collapse-runs `/_+/g` reduced to
// a single-underscore match, which is a no-op since replacing "_" with "_"
// changes nothing). The existing tests only ever produce ONE invalid
// character in a row.
describe("sanitizeToolName — collapses MULTIPLE consecutive invalid chars to one underscore", () => {
  test("two consecutive spaces collapse to a single underscore, not two", () => {
    expect(sanitizeToolName("foo  bar")).toBe("foo_bar");
  });
});

// 31:14-31:27 Regex [Survived] `/^[^a-z0-9]/` (the leading-strip `+`
// quantifier dropped, stripping only ONE leading invalid char instead of
// all of them) and 31:29-31:31 StringLiteral [Survived] `"Stryker was
// here!"` (the removal replacement text). Needs a MULTI-CHAR leading
// invalid run that ISN'T underscores (underscore runs are already
// collapsed to one by the previous step, so only hyphens can still form a
// multi-char leading run at this point).
describe("sanitizeToolName — strips ALL leading invalid characters, not just one", () => {
  test("two leading hyphens are both stripped, landing on a valid tool name", () => {
    expect(sanitizeToolName("--foo")).toBe("foo");
  });
});

// 32:21-32:44 MethodExpression [Survived] (`.slice(0, MAX_LEN)` dropped
// entirely). The existing test only checks `result.length <= 63`, which
// the mutant ALSO satisfies — via the "op" fallback, since an untruncated
// 100-char string fails TOOL_NAME_RE's own length cap and falls through to
// "op" (length 2). Only an EXACT value assertion distinguishes "63 a's"
// from "op".
describe("sanitizeToolName — truncates to exactly MAX_LEN, not the 'op' fallback", () => {
  test("a 100-char input truncates to the first 63 chars, not 'op'", () => {
    expect(sanitizeToolName("a".repeat(100))).toBe("a".repeat(63));
  });
});

// 53:27-53:35 UpdateOperator [Survived] (`suffix++` -> `suffix--`). A
// SINGLE collision can't distinguish these — the post-increment/decrement
// both read the ORIGINAL value (2) on their first use. A SECOND sequential
// collision on the same base name is needed to observe which direction the
// suffix actually moves next.
describe("uniqueToolName — the suffix counts UP across sequential collisions, not down", () => {
  test("a second collision (foo, foo_2 both taken) yields foo_3, not foo_1", () => {
    const used = new Set(["foo", "foo_2"]);
    expect(uniqueToolName("foo", used)).toBe("foo_3");
  });
});
