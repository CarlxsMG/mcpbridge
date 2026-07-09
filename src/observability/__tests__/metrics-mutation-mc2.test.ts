import { describe, test, expect } from "bun:test";
import { Counter, Histogram, MetricsRegistry } from "../../observability/metrics.js";

/**
 * Stryker mutation backstop for cluster mc2: src/observability/metrics.ts lines 82-160
 * (the Histogram class in full, plus MetricsRegistry). See
 * src/observability/__tests__/metrics.test.ts for the general-behavior Counter/Gauge/
 * Histogram/MetricsRegistry tests this file intentionally does not duplicate.
 *
 * Ground truth re-queried directly from reports/mutation/result.json (baseline run),
 * filtered to mutants with location.start.line in [82, 160] and status !== "Killed".
 * 19 mutants total in range: 17 Survived + 2 Timeout.
 *
 * ── Documented equivalent (no test written) ─────────────────────────────────────
 * Mutant id 47, EqualityOperator, 109:21-44, `i < this.buckets.length` -> `i <= this.buckets.length`
 * (Histogram#observe's per-bucket loop). Empirically verified equivalent via
 * scratch/verify-mc2.mjs: the loop body is `if (value <= this.buckets[i]) bkts[i]++;`. For the
 * mutated bound's one extra iteration, i === this.buckets.length, so `this.buckets[i]` is an
 * out-of-bounds array read, which is `undefined` in JS (no throw). The comparison
 * `value <= undefined` is *always* false per the spec's abstract relational comparison (ToNumber
 * (undefined) is NaN, and `<=` on a NaN operand returns false), for every real value tried
 * (0, -1, 1, 100, NaN itself). So the extra iteration's `if` never fires, `bkts[i]++` never runs,
 * and `counts`/`sums`/`totals` end up byte-for-byte identical to the unmutated loop for every
 * input -- there is no code path, direct or indirect (render() included), through which this
 * mutation's effect can be observed. Confirmed by simulating both loop bounds side by side in
 * scratch/verify-mc2.mjs across 7 representative values against 3 buckets: every result matched
 * and no extra array slot was ever written.
 *
 * ── Timeout mutants (not "Survived"; no dedicated test needed) ──────────────────
 * Mutant id 49, UpdateOperator, 109:46-49, `i++` -> `i--` (observe's loop) and mutant id 77,
 * UpdateOperator, 129:48-51, `i++` -> `i--` (render's loop) both report status "Timeout" in the
 * baseline run, not "Survived": decrementing `i` from 0 while the bound check is `i < length`
 * (length > 0 for every histogram in this codebase) never becomes false, so the mutated process
 * hangs until Stryker's timeout kills it. That is already a detected (non-surviving) outcome, so
 * no additional unit test is required for these two ids.
 */

describe("Histogram mutation backstop (mc2)", () => {
  // Kills id 36 (MethodExpression, 97:20-54, `[...buckets].sort(...)` -> `[...buckets]`),
  // id 38 (ArrowFunction, 97:38-53, `(a, b) => a - b` -> `() => undefined`), and
  // id 39 (ArithmeticOperator, 97:48-53, `a - b` -> `a + b`). Verified empirically in
  // scratch/verify-mc2.mjs that all three mutations leave the input [5, 1, 10] unsorted,
  // diverging from the correct ascending [1, 5, 10].
  test("sorts buckets ascending regardless of constructor input order", () => {
    const h = new Histogram("mc2_unsorted_hist", "unsorted buckets", [5, 1, 10]);
    expect(h.buckets).toEqual([1, 5, 10]);
  });

  // Kills id 53 (EqualityOperator, 110:11-35, `value <= this.buckets[i]` -> `value < this.buckets[i]`).
  // Prometheus histogram buckets are inclusive ("less than or equal"); an observation exactly
  // equal to a bucket boundary must increment that bucket. With the mutant's strict `<`, the
  // le="5" bucket would stay at 0 instead of 1.
  test("increments bucket count inclusively when value exactly equals a bucket boundary", () => {
    const h = new Histogram("mc2_boundary_hist", "boundary test", [1, 5, 10]);
    h.observe({}, 5);
    const out = h.render();
    expect(out).toContain('mc2_boundary_hist_bucket{le="1"} 0');
    expect(out).toContain('mc2_boundary_hist_bucket{le="5"} 1');
    expect(out).toContain('mc2_boundary_hist_bucket{le="10"} 1');
  });

  // Kills id 62 (StringLiteral, 118:30-64, `` `# HELP ${this.name} ${this.help}` `` -> `` `` ``).
  test("includes a HELP line with the metric name and help text", () => {
    const h = new Histogram("mc2_help_hist", "Describes mc2 help text", [1]);
    const out = h.render();
    expect(out).toContain("# HELP mc2_help_hist Describes mc2 help text");
  });

  // Kills id 65 (ConditionalExpression, 123:9-39, `Object.keys(labels).length > 0` -> `true`),
  // id 67 (EqualityOperator, same span, `> 0` -> `>= 0`), id 73 (StringLiteral, 127:13-28,
  // `` `{le="{{LE}}"}` `` -> `` `` ``), id 81 (ConditionalExpression, 133:9-39, same condition
  // as 65 for the +Inf branch), id 83 (EqualityOperator, same span, `> 0` -> `>= 0`), and id 89
  // (StringLiteral, 137:13-26, `` `{le="+Inf"}` `` -> `` `` ``). All six collapse the "no labels"
  // ternary branch for either the bucket line or the +Inf line: 65/67/81/83 wrongly force the
  // "has labels" branch even for an empty labels object (producing a stray leading comma from
  // `Object.entries({}).join(",")` => ""), and 73/89 blank out the "no labels" branch entirely
  // (dropping the `{le="..."}" part outright).
  test("omits any stray comma or malformed braces for bucket/+Inf lines when no labels are supplied", () => {
    const h = new Histogram("mc2_nolabel_hist", "no labels", [1, 5, 10]);
    h.observe({}, 3);
    const out = h.render();
    expect(out).toContain('mc2_nolabel_hist_bucket{le="1"} 0');
    expect(out).toContain('mc2_nolabel_hist_bucket{le="5"} 1');
    expect(out).toContain('mc2_nolabel_hist_bucket{le="10"} 1');
    expect(out).toContain('mc2_nolabel_hist_bucket{le="+Inf"} 1');
    expect(out).not.toContain(",le=");
  });

  // Kills id 72 (StringLiteral, 126:21-24, `","` -> `""` in the with-labels bucket-line join) and
  // id 88 (StringLiteral, 136:21-24, same mutation in the with-labels +Inf-line join). With two
  // label entries, removing the join separator drops the comma between them.
  test("separates multiple label entries with a comma in bucket and +Inf lines", () => {
    const h = new Histogram("mc2_multilabel_hist", "multi label", [1, 5, 10]);
    h.observe({ a: "x", b: "y" }, 3);
    const out = h.render();
    expect(out).toContain('mc2_multilabel_hist_bucket{a="x",b="y",le="5"} 1');
    expect(out).toContain('mc2_multilabel_hist_bucket{a="x",b="y",le="+Inf"} 1');
  });

  // Kills id 75 (EqualityOperator, 129:23-46, `i < this.buckets.length` -> `i <= this.buckets.length`
  // in render()'s bucket loop). Unlike the equivalent observe()-loop mutant (id 47), this one IS
  // observable: the extra iteration directly renders `this.buckets[length]` (undefined) and
  // `bkts[length]` (undefined) into an extra pushed line, with no guarding `if`.
  test("renders exactly one finite bucket line per configured bucket, plus one +Inf line", () => {
    const h = new Histogram("mc2_exactcount_hist", "exact count", [1, 5, 10]);
    h.observe({}, 3);
    const out = h.render();
    const bucketLines = out.split("\n").filter((line) => line.startsWith("mc2_exactcount_hist_bucket"));
    expect(bucketLines).toHaveLength(4); // 3 finite buckets + 1 +Inf line
    expect(out).not.toContain("undefined");
  });

  // Kills id 96 (StringLiteral, 142:23-27, `lines.join("\n")` -> `lines.join("")` in
  // Histogram#render). Without the newline separator, the TYPE line and the following bucket
  // line would be glued together with no break between them.
  test("joins histogram render lines with actual newline characters, not concatenation", () => {
    const h = new Histogram("mc2_join_hist", "join test", [1]);
    h.observe({}, 1);
    const out = h.render();
    expect(out).toContain('# TYPE mc2_join_hist histogram\nmc2_join_hist_bucket{le="1"} 1');
  });
});

describe("MetricsRegistry mutation backstop (mc2)", () => {
  // Kills id 101 (StringLiteral, 158:53-59, `.join("\n\n")` -> `.join("")` in
  // MetricsRegistry#render). Needs at least two registered metrics -- Array#join's separator has
  // no observable effect on a single-element array, which is why the existing "ends with a
  // newline" test (single counter) doesn't already cover this.
  test("joins multiple registered metrics with a blank line (double newline) separator", () => {
    const r = new MetricsRegistry();
    const c1 = r.register(new Counter("mc2_reg_a_total", "metric a"));
    const c2 = r.register(new Counter("mc2_reg_b_total", "metric b"));
    c1.inc({}, 1);
    c2.inc({}, 2);
    const out = r.render();
    expect(out).toBe(`${c1.render()}\n\n${c2.render()}\n`);
  });
});
