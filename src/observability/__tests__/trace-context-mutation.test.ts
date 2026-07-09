/**
 * Stryker mutation-testing backstop for src/observability/trace-context.ts —
 * domain 7.
 *
 * Baseline: 99 mutants, 83 killed / 14 survived / 2 timeouts. All line:col
 * citations below were read directly from reports/mutation/result.json.
 *
 * Documented equivalents (verified, not assumed):
 *
 *   59:7-59:19 ConditionalExpression false and 59:17-59:19 StringLiteral
 *   (`if (value === "") return null;` forced off / its `""` literal replaced
 *   with a sentinel). `"".split("-")` always yields exactly `[""]` — a
 *   single-element array — so whenever `value` is empty (or reduces to empty
 *   after `.trim()`), the VERY NEXT guard, `if (parts.length < 4) return
 *   null;` (line 63, still real/unmutated when line 59 is the one being
 *   tested), independently catches it: `1 < 4` is always true. Both of line
 *   59's own mutants converge on the identical `null` result via this
 *   downstream guard. Verified empirically across three empty/whitespace-only
 *   inputs (`""`, `"   "`, `"\t\n"`) producing byte-identical real/mutant
 *   results in every case.
 *
 *   63:7-63:23 ConditionalExpression false (`if (parts.length < 4) return
 *   null;` forced off). Every destructured field left `undefined` by too
 *   few dash-separated parts fails its OWN downstream regex check anyway —
 *   `TRACE_ID_RE.test(undefined)`/`SPAN_ID_RE.test(undefined)`/
 *   `FLAGS_RE.test(undefined)` all coerce `undefined` to the literal string
 *   "undefined", which matches none of the three hex patterns — so skipping
 *   the length guard converges on the identical `null` result via whichever
 *   field-format check runs first. Verified empirically across 6 malformed
 *   inputs (0-3 dash-separated parts, with and without an otherwise-valid
 *   leading field) producing byte-identical real/mutant results in every case.
 *
 *   70:7-70:33 ConditionalExpression false (`if (!Number.isFinite(flagByte))
 *   return null;` forced off, in parseTraceparent). By the time this line
 *   runs, `flags` has ALREADY passed `FLAGS_RE.test(flags)` one line above
 *   (`/^[0-9a-f]{2}$/`), which guarantees exactly two lowercase hex digits —
 *   `Number.parseInt` on any such pair always yields a finite integer in
 *   [0, 255]. There is no two-lowercase-hex-digit string for which
 *   `Number.parseInt(flags, 16)` is non-finite, so this guard can never
 *   actually fire given the regex that already ran.
 *
 *   143:7-143:51 (both the ConditionalExpression and EqualityOperator
 *   variants, in setCurrentSpan's `if (traceContextStorage.getStore() ===
 *   undefined) return;` guard) reported by Stryker as Timeout, not Survived
 *   — accepted per this program's established "genuine Stryker timeout =
 *   detected" convention (same as auth.ts/transports.ts/mcp-server.ts
 *   elsewhere in this program). Not chased with a dedicated test.
 */
import { describe, test, expect, spyOn } from "bun:test";
import * as cryptoMod from "node:crypto";
import {
  parseTraceparent,
  newTraceId,
  newSpanId,
  outboundTraceHeaders,
  withTraceContext,
} from "../../observability/trace-context.js";

// Each test below spies on cryptoMod.randomBytes and restores it itself via
// spy.mockRestore() in a finally block -- node:crypto's own exports are
// frozen, so a manual reassignment (as opposed to bun:test's own spyOn
// restore mechanism) would throw "Attempted to assign to readonly property".

describe("parseTraceparent — anchored hex-length regexes", () => {
  // Kills 44:21-44:37 Regex (both the `^`-dropped and `$`-dropped variants
  // of TRACE_ID_RE). Existing tests only try inputs SHORTER than 32 hex
  // chars; an unanchored regex still matches a string LONGER than 32 chars
  // that merely CONTAINS a 32-hex run at the start or end.
  test("a trace-id one character too long (with a valid 32-hex run at the start) is rejected, not loosely matched", () => {
    const tooLong = "a".repeat(33); // first 32 chars are a valid run; anchor-less regexes would match anyway
    const raw = `00-${tooLong}-${"b".repeat(16)}-01`;
    expect(parseTraceparent(raw)).toBeNull();
  });

  // Kills 45:20-45:36 Regex (both anchor variants of SPAN_ID_RE) — same
  // over-length technique applied to the 16-hex parent-span-id field.
  test("a parent-span-id one character too long is rejected, not loosely matched", () => {
    const tooLong = "b".repeat(17);
    const raw = `00-${"a".repeat(32)}-${tooLong}-01`;
    expect(parseTraceparent(raw)).toBeNull();
  });

  // Kills 46:18-46:33 Regex (both anchor variants of FLAGS_RE) — an
  // over-length flags field ("011", 3 chars) whose first two characters
  // are themselves valid hex.
  test("a flags field one character too long is rejected, not loosely matched", () => {
    const raw = `00-${"a".repeat(32)}-${"b".repeat(16)}-011`;
    expect(parseTraceparent(raw)).toBeNull();
  });
});

describe("parseTraceparent — empty-after-trim guard", () => {
  // Regression check for real behavior (see header comment: this line's own
  // two mutants are both documented equivalents, always masked by the
  // downstream parts.length < 4 guard) -- a whitespace-only header must
  // still resolve to null, whichever guard is the one that actually catches
  // it internally.
  test("a whitespace-only header reduces to empty after trim and returns null", () => {
    expect(parseTraceparent("   ")).toBeNull();
  });
});

describe("parseTraceparent — flags format vs. mere parseability", () => {
  // Kills 68:7-68:28 ConditionalExpression false (`if (!FLAGS_RE.test(flags))
  // return null;`). An uppercase-hex flags value ("AB") is the right WIDTH
  // and parses to a perfectly finite number via parseInt (which is
  // case-insensitive), so it is NOT caught by the later
  // Number.isFinite(flagByte) check -- only the regex's lowercase-only
  // requirement distinguishes it.
  test("uppercase-hex flags are rejected even though they'd parse to a finite number", () => {
    const raw = `00-${"a".repeat(32)}-${"b".repeat(16)}-AB`;
    expect(parseTraceparent(raw)).toBeNull();
  });
});

describe("newTraceId / newSpanId — all-zero collision retry", () => {
  // Kills 92:7-92:29 ConditionalExpression false (`if (id === ALL_ZEROS_TRACE)
  // id = newTraceId();`). The existing 1000-iteration test relies on real
  // randomness never actually hitting all-zeros (astronomically unlikely),
  // which can't distinguish the guard from its absence. Mocks randomBytes
  // to deterministically return an all-zero buffer once, then a real-looking
  // one, forcing the retry path to actually execute.
  test("an all-zero trace-id from randomBytes is discarded and regenerated", () => {
    const spy = spyOn(cryptoMod, "randomBytes") as unknown as ReturnType<typeof spyOn>;
    let call = 0;
    spy.mockImplementation(((size: number) => {
      call++;
      return call === 1 ? Buffer.alloc(size, 0) : Buffer.alloc(size, 0xab);
    }) as unknown as typeof cryptoMod.randomBytes);
    try {
      const id = newTraceId();
      expect(id).not.toBe("0".repeat(32));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 99:7-99:28 ConditionalExpression false (`if (id === ALL_ZEROS_SPAN)
  // id = newSpanId();`) — same technique for the 8-byte span-id generator.
  test("an all-zero span-id from randomBytes is discarded and regenerated", () => {
    const spy = spyOn(cryptoMod, "randomBytes") as unknown as ReturnType<typeof spyOn>;
    let call = 0;
    spy.mockImplementation(((size: number) => {
      call++;
      return call === 1 ? Buffer.alloc(size, 0) : Buffer.alloc(size, 0xcd);
    }) as unknown as typeof cryptoMod.randomBytes);
    try {
      const id = newSpanId();
      expect(id).not.toBe("0".repeat(16));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("outboundTraceHeaders — tracestate is set only when actually present", () => {
  // Kills 186:7-186:21 ConditionalExpression true (`if (ctx.tracestate)
  // headers.set("tracestate", ctx.tracestate);` forced unconditional). With
  // no tracestate in context, the mutant would call
  // `headers.set("tracestate", null)`, which Headers coerces to the literal
  // string "null" instead of omitting the header entirely.
  test("no tracestate in context means the header is entirely absent, not set to a coerced value", () => {
    withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () => {
      const headers = outboundTraceHeaders();
      expect(headers.has("tracestate")).toBe(false);
    });
  });
});
