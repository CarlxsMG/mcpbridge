import { describe, test, expect } from "bun:test";
import { Counter, Gauge } from "../../observability/metrics.js";

// Cluster mc1 — src/observability/metrics.ts lines 8-80: the label helpers
// (formatLabels, escapeLabel, seriesKey — all module-private) plus the Counter and Gauge
// classes in full (constructor, inc/set, render).
//
// formatLabels/escapeLabel/seriesKey are not exported, so every test below drives them
// indirectly through hand-rolled Counter/Gauge instances (same approach as the existing
// dedicated metrics.test.ts), never by importing the real metricsRegistry constants
// (that's cluster mc3's concern) and never by touching the legacy-metrics module state
// (that's cluster mc4's concern).
//
// Ground truth re-queried directly from reports/mutation/result.json, filtered to
// location.start.line in [8, 80] and status !== "Killed": exactly 8 Survived mutants
// (no Timeouts in range). Each is cited inline above the test that kills it:
//   id 10 (16:27-33 StringLiteral, "\\\\" -> "")   escapeLabel's backslash-doubling replace
//   id 11 (16:49-54 StringLiteral, '\\"' -> "")    escapeLabel's quote-escaping replace
//   id 12 (16:71-76 StringLiteral, "\\n" -> "")    escapeLabel's newline-escaping replace
//   id 14 (20:33-59 MethodExpression, Object.keys(labels).sort() -> Object.keys(labels))
//                                                  seriesKey's key-sort (order independence)
//   id 21 (44:30-64 StringLiteral, `# HELP ${this.name} ${this.help}` -> ``)  Counter.render()
//   id 25 (49:23-27 StringLiteral, "\n" -> "")     Counter.render()'s lines.join separator
//   id 30 (73:30-64 StringLiteral, `# HELP ${this.name} ${this.help}` -> ``)  Gauge.render()
//   id 34 (78:23-27 StringLiteral, "\n" -> "")     Gauge.render()'s lines.join separator

describe("escapeLabel — driven via Counter.inc()/render() label values (cluster mc1)", () => {
  // Empirically verified (scratch script) that for a single literal backslash character in
  // a label value, the real escapeLabel doubles it to two backslash characters in the
  // rendered output, while the id-10 mutant (first .replace(...) blanked to "") drops the
  // backslash entirely instead of doubling it — so the exact rendered substring below only
  // matches under the real, unmutated replace chain.
  // kills id 10 (16:27-33 StringLiteral)
  test("doubles a literal backslash character in a rendered label value", () => {
    const c = new Counter("t_mc1_escape_backslash", "escape backslash test");
    c.inc({ val: "back\\slash" }); // label value contains exactly one backslash char
    const out = c.render();
    expect(out).toContain('val="back\\\\slash"'); // rendered with two backslash chars
  });

  // Empirically verified (scratch script) that a literal double-quote character inside a
  // label value is escaped to a backslash followed by a quote; the id-11 mutant (second
  // .replace(...) blanked to "") strips the quote characters out entirely instead of
  // escaping them, which is a different, distinguishable rendered string.
  // kills id 11 (16:49-54 StringLiteral)
  test("escapes an embedded double-quote character in a rendered label value", () => {
    const c = new Counter("t_mc1_escape_quote", "escape quote test");
    c.inc({ val: 'say "hi"' });
    const out = c.render();
    expect(out).toContain('val="say \\"hi\\""');
  });

  // Empirically verified (scratch script) that a literal newline character inside a label
  // value is replaced with the two-character text sequence backslash-n; the id-12 mutant
  // (third .replace(...) blanked to "") strips the newline out entirely (leaving the two
  // halves concatenated with nothing between them) instead of producing the backslash-n
  // text, which is a different, distinguishable rendered string.
  // kills id 12 (16:71-76 StringLiteral)
  test("replaces a literal newline character with a backslash-n text sequence in a rendered label value", () => {
    const c = new Counter("t_mc1_escape_newline", "escape newline test");
    c.inc({ val: "line1\nline2" }); // label value contains one real newline char
    const out = c.render();
    expect(out).toContain('val="line1\\nline2"'); // literal backslash + "n", not a real newline
  });
});

describe("seriesKey — label key order independence (cluster mc1)", () => {
  // Empirically verified (scratch script): JSON.stringify's replacer-array argument both
  // filters AND fixes the output property order, using the replacer array's own order —
  // NOT the source object's insertion order. So Object.keys(labels).sort() (real code) always
  // produces the same replacer array (e.g. ["a","b"]) regardless of which order the caller
  // built the labels object in, making two label objects with the same keys in different
  // insertion order hash to the identical seriesKey and merge into one Counter series. Without
  // the .sort() (id-14 mutant), Object.keys(labels) reflects insertion order, so the same two
  // calls below would produce two DIFFERENT seriesKeys and thus two separate, unmerged series
  // each holding the per-call increment instead of one merged series holding the sum.
  // kills id 14 (20:33-59 MethodExpression)
  test("merges differently-ordered-but-identical label objects into a single series", () => {
    const c = new Counter("t_mc1_serieskey_sort_total", "seriesKey sort test");
    c.inc({ b: "2", a: "1" });
    c.inc({ a: "1", b: "2" });
    const out = c.render();
    const seriesLines = out.split("\n").filter((l) => l.startsWith("t_mc1_serieskey_sort_total{"));
    expect(seriesLines.length).toBe(1);
    expect(seriesLines[0]).toBe('t_mc1_serieskey_sort_total{a="1",b="2"} 2');
  });
});

describe("Counter.render() (cluster mc1)", () => {
  // kills id 21 (44:30-64 StringLiteral)
  test("emits the exact HELP header line with the metric's name and help text", () => {
    const c = new Counter("t_mc1_render_help_counter", "a distinctive counter help string");
    const out = c.render();
    expect(out).toContain("# HELP t_mc1_render_help_counter a distinctive counter help string");
  });

  // kills id 25 (49:23-27 StringLiteral)
  test("joins its rendered lines with real newline separators, not concatenation", () => {
    const c = new Counter("t_mc1_render_join_counter", "join separator test");
    const out = c.render();
    expect(out).toBe("# HELP t_mc1_render_join_counter join separator test\n# TYPE t_mc1_render_join_counter counter");
  });
});

describe("Gauge.render() (cluster mc1)", () => {
  // kills id 30 (73:30-64 StringLiteral)
  test("emits the exact HELP header line with the metric's name and help text", () => {
    const g = new Gauge("t_mc1_render_help_gauge", "a distinctive gauge help string");
    const out = g.render();
    expect(out).toContain("# HELP t_mc1_render_help_gauge a distinctive gauge help string");
  });

  // kills id 34 (78:23-27 StringLiteral)
  test("joins its rendered lines with real newline separators, not concatenation", () => {
    const g = new Gauge("t_mc1_render_join_gauge", "join separator test");
    const out = g.render();
    expect(out).toBe("# HELP t_mc1_render_join_gauge join separator test\n# TYPE t_mc1_render_join_gauge gauge");
  });
});
