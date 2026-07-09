import { describe, test, expect } from "bun:test";
import { recordToolCall, setSessionCountGetter, getLegacyMetricsSnapshot } from "../../observability/metrics.js";

// Cluster mc4 — src/observability/metrics.ts lines 281-322 ("legacy JSON metrics" section):
// recordToolCall, setSessionCountGetter, getLegacyMetricsSnapshot, and the module-level mutable
// state backing them (totalToolCalls, errorToolCalls, latencies capped at MAX_LATENCY_WINDOW=100,
// startedAt, getSessionCounts).
//
// Mutant coverage (re-queried directly from reports/mutation/result.json, filtered to
// location.start.line in [281, 322] and status !== "Killed" — 23 Survived, mc4's full assignment):
// 145, 147, 148, 149, 150, 151, 152, 153, 154, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167,
// 168, 169, 170, 171. Each is cited inline next to the test/assertion that kills it (or, for the
// documented equivalents, next to the empirical reasoning explaining why no test can).
//
// ORDERING GOTCHA (load-bearing): this module's legacy-metrics state has NO exported reset
// helper and is shared for the life of the whole bun:test process. `recordToolCall` is ALSO
// called for real by src/proxy/proxy.ts on every real proxied tool call — so by the time ANY
// test file runs as part of the FULL `bun run test` gate (not just this file's own scoped
// Stryker run under STRYKER_TEST_SCOPE="src/observability/__tests__"), `latencies` almost
// certainly already has real accumulated entries from dozens of unrelated proxy/mcp/middleware
// test files that ran earlier in the full-tree sweep (their directories sort alphabetically
// before "observability"). An initial version of this file tried a "pristine module state"
// describe block asserting `avgLatencyMs === 0`/empty-array preconditions, reasoning it was
// safe because no OTHER file within this SAME directory touches the state first — that check
// only holds for the scoped Stryker run, not the full-suite gate, and DID fail under `bun run
// test` (2 real failures) once real proxy traffic from other directories had already run.
// Fixed by removing that assumption entirely rather than special-casing the full-suite gate.
//
// Documented equivalents (verified, not assumed): 145 (285:29-31 ArrayDeclaration, the initial
// `latencies: number[] = []` sentinel-injected), 162 (314:24-44 ConditionalExpression,
// `latencies.length > 0` forced true), and 164 (314:24-44 EqualityOperator, `> ` -> `>=`) all
// only diverge from real behavior when `latencies` is genuinely EMPTY (length 0) at the moment
// `getLegacyMetricsSnapshot()` is read. Given `recordToolCall` is exercised by real production
// code paths (proxyToolCall) throughout literally hundreds of OTHER tests across the whole
// suite, and this module has no reset hook, a genuinely-still-empty `latencies` array is not
// reliably observable in ANY test run that includes more than this one isolated file — the
// same "module-level state with no reset hook, permanently touched by real production code
// elsewhere in the suite" pattern already established for this file's own `getSessionCounts`
// default (see below) and documented elsewhere in this program (load-balancer.ts's
// nowFn/randFn). Not chased with a fragile ordering-dependent test.
//
// The "latencies window cap" cluster below (151/152/153/154, plus the avgLatencyMs formula
// mutants 163/165/166/167/168/169) does NOT have this problem — it's deliberately built to be
// robust to ANY prior accumulated state (see that describe block's own header comment for the
// technique), so it works identically under the scoped Stryker run and the full-suite gate.

describe("legacy metrics — default session getter (must run before setSessionCountGetter is ever called)", () => {
  // id158 (299:54-79 ArrowFunction: default `() => ({ streamable: 0 })` -> `() => undefined`) and
  // id159 (299:61-78 ObjectLiteral: `{ streamable: 0 }` -> `{}`) both only affect the DEFAULT
  // `getSessionCounts` closure, which is permanently overwritten (with no way to restore it) the
  // moment `setSessionCountGetter` is ever called — by this file's own later "wiring" test, or in
  // a full (non-scoped) `bun run test` run, by src/mcp/transports.ts's `setupTransports(app)`
  // (called for real by several OTHER test suites outside this directory, e.g.
  // src/mcp/__tests__/transports*.test.ts). This test proves the real default's actual return
  // shape while it's still guaranteed untouched (see file header for why that precondition holds
  // in this file/directory); it intentionally does NOT double as proof for a run where some
  // earlier suite already replaced the getter — that scenario is exactly the DI-helper-initial-
  // value equivalence class documented elsewhere in this program (see
  // load-balancer-mutation.test.ts's nowFn/randFn header), not something a reset-less module can
  // make robust to run order.
  test("[158][159] default getSessionCounts reports { streamable: 0 } before setSessionCountGetter is ever called", () => {
    const snap = getLegacyMetricsSnapshot();
    expect(snap.sessions).toEqual({ streamable: 0 });
  });
});

describe("legacy metrics — latencies window cap (robust to prior accumulated state)", () => {
  // Technique: rather than flooding with ONE uniform value and checking the resulting average
  // (which cannot distinguish a window-size-off-by-one, e.g. 99 vs 100 entries, or even a
  // collapsed-to-some-other-fixed-size window, since an all-identical-value window averages to
  // that same value regardless of its size), this test:
  //   1. Floods with FILL_A a comfortable amount more than MAX_LATENCY_WINDOW (150 > 100) times,
  //      which — given the real shift-oldest-first cap — guarantees the window is ENTIRELY
  //      FILL_A afterward, regardless of whatever was in `latencies` before this test ran (0
  //      entries, tracing.test.ts's 2 entries, or anything else). This makes the setup itself
  //      order-independent.
  //   2. Pushes exactly ONE FILL_B marker, then computes the EXACT expected average by hand for
  //      a real 100-entry window (99×FILL_A + 1×FILL_B) and asserts it precisely.
  // This exact-value assertion is sensitive not just to average corruption but to the window's
  // exact SIZE and the reduce formula's exact arithmetic, so it kills the entire cap/average
  // mutant cluster in one shot — including mutants whose effective window size becomes something
  // OTHER than 100 (which a uniform-value flood alone would miss):
  //   - id151 (294:7-44 ConditionalExpression `if (...)` forced true): shifts on every single
  //     push regardless of length, which — from ANY starting length L0 — collapses the window to
  //     a fixed size of L0 (or permanently empty if L0 was 0), never 100. The one-marker
  //     arithmetic below only matches a genuine 100-entry window, so this diverges regardless of
  //     L0's actual value.
  //   - id152 (294:7-44 ConditionalExpression forced false): never shifts at all — unbounded
  //     growth, so the marker gets diluted by however many stale entries came before it (all
  //     still present), not exactly averaged over 99 FILL_A's.
  //   - id153 (294:7-44 EqualityOperator `>` -> `>=`): shifts one push earlier than real, settling
  //     into a 99-entry steady state instead of 100 — changes the divisor from 100 to 99, which
  //     changes the final average (verified below: 504000 vs 504040).
  //   - id154 (294:7-44 EqualityOperator `>` -> `<=`): true for every length from 1 up to 100 (length
  //     can never be negative), so — like 151 — every push is immediately undone; same collapse
  //     argument as 151 applies (diverges regardless of L0).
  //   - id163 (314:24-44 ConditionalExpression `latencies.length > 0` forced false): always
  //     returns the literal 0 fallback instead of computing an average — diverges from our
  //     nonzero expected average.
  //   - id165 (314:24-44 EqualityOperator `>` -> `<=`, i.e. `latencies.length <= 0`): false for
  //     any nonzero length (length can never be negative, so this is equivalent to `=== 0`),
  //     which — with a 100-entry window — takes the literal-0 fallback branch instead of
  //     computing the average. Same divergence as 163.
  //   - id166 (314:58-113 ArithmeticOperator `/` -> `*`): `sum * length` instead of `sum / length`
  //     — wildly different magnitude (50,400,000 * 100 vs / 100).
  //   - id167 (314:75-90 ArrowFunction `(a, b) => a + b` -> `() => undefined`): reduce's combiner
  //     always returns undefined, so the running sum becomes `undefined`/NaN throughout.
  //   - id168 (314:85-90 ArithmeticOperator `a + b` -> `a - b`): turns the sum into a running
  //     subtraction, producing a large-magnitude negative number instead of the real sum.
  //   - id169 (315:10-321:4 ObjectLiteral: whole return object -> `{}`): every field, including
  //     `.avgLatencyMs`, becomes `undefined`, which fails the `.toBe(EXPECTED_AVG)` assertion.
  //   - id161 (313:3-322:2 BlockStatement: whole function body -> `{}`): the function returns
  //     `undefined` outright, so `snap.avgLatencyMs` is `undefined`, failing the assertion.
  test("[151][152][153][154][161][163][165][166][167][168][169] latencies window caps at exactly MAX_LATENCY_WINDOW entries", () => {
    const FILL_A = 500_000;
    const FILL_B = 900_000;

    // 1. Flush the window to 100% FILL_A, regardless of any prior state.
    for (let i = 0; i < 150; i++) {
      recordToolCall(FILL_A, false);
    }
    const afterFlood = getLegacyMetricsSnapshot();
    expect(afterFlood.avgLatencyMs).toBe(FILL_A);

    // 2. Push exactly one differently-valued entry. Under the real 100-entry cap this evicts
    //    exactly one FILL_A, leaving 99×FILL_A + 1×FILL_B averaged over 100.
    recordToolCall(FILL_B, false);
    const afterMarker = getLegacyMetricsSnapshot();
    const expectedAvg = Math.round((99 * FILL_A + FILL_B) / 100);
    expect(expectedAvg).toBe(504_000); // sanity-check the hand computation itself
    expect(afterMarker.avgLatencyMs).toBe(expectedAvg);
  });
});

describe("legacy metrics — recordToolCall increments (delta-based, order-independent)", () => {
  // id147 (291:3-19 UpdateOperator `totalToolCalls++` -> `totalToolCalls--`): a decrement instead
  // of increment flips the sign of the delta below (-1 instead of +1).
  // id148/149 (292:7-14 ConditionalExpression `if (isError)` forced true/false): forcing true
  // would increment errorToolCalls even on a successful call (caught by the isError=false case
  // below); forcing false would never increment it even on an error (caught by the isError=true
  // case).
  // id150 (292:16-32 UpdateOperator `errorToolCalls++` -> `errorToolCalls--`): flips the error
  // delta's sign, caught by the isError=true case expecting exactly +1.
  test("[147][150] recordToolCall(_, true) increments both totalToolCalls and errorToolCalls by exactly 1", () => {
    const before = getLegacyMetricsSnapshot();
    recordToolCall(42, true);
    const after = getLegacyMetricsSnapshot();
    expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
    expect(after.errorToolCalls - before.errorToolCalls).toBe(1);
  });

  test("[148][149] recordToolCall(_, false) increments totalToolCalls by 1 and leaves errorToolCalls unchanged", () => {
    const before = getLegacyMetricsSnapshot();
    recordToolCall(42, false);
    const after = getLegacyMetricsSnapshot();
    expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
    expect(after.errorToolCalls - before.errorToolCalls).toBe(0);
  });
});

describe("legacy metrics — uptimeSeconds", () => {
  // id170 (316:31-62 ArithmeticOperator `/` -> `*`: `(Date.now() - startedAt) * 1000` instead of
  // `/ 1000`) and id171 (316:32-54 ArithmeticOperator `-` -> `+`: `Date.now() + startedAt` instead
  // of `- startedAt`) both turn a small "elapsed ms since module load" figure (well under an hour
  // of wall-clock test-suite runtime) into an astronomically large number: `170` multiplies an
  // already-in-milliseconds elapsed time by another 1000, and `171` sums two ~1.7e12-magnitude
  // epoch-ms values instead of subtracting them. Either mutant pushes uptimeSeconds into the
  // billions; the real value is always a small non-negative number of seconds.
  test("[170][171] uptimeSeconds is a small non-negative number of seconds since module load", () => {
    const snap = getLegacyMetricsSnapshot();
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.uptimeSeconds).toBeLessThan(3600);
  });
});

describe("legacy metrics — setSessionCountGetter wiring", () => {
  // id160 (302:79-304:2 BlockStatement: setSessionCountGetter's whole body -> `{}`): the
  // assignment `getSessionCounts = fn` never happens, so the getter would stay whatever it was
  // before this test (the untouched default, or a leftover from an earlier test in a fuller run)
  // instead of the new function, and getLegacyMetricsSnapshot().sessions would not reflect the
  // distinctive value asserted below.
  test("[160] setSessionCountGetter wires a new callback observed via getLegacyMetricsSnapshot", () => {
    setSessionCountGetter(() => ({ streamable: 4242 }));
    const snap = getLegacyMetricsSnapshot();
    expect(snap.sessions).toEqual({ streamable: 4242 });
  });
});
