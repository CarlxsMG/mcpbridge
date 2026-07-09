/**
 * Stryker mutation-testing backstop for src/observability/anomaly.ts — domain 7,
 * first file. Test dir is CROSS-DIRECTORY (same gotcha class as domain 5's
 * backend-auth and domain 3's load-balancer.ts): the file lives at
 * src/observability/anomaly.ts but its dedicated test (anomaly.test.ts) lives at
 * src/admin/entities/__tests__/, so this backstop lives alongside it rather than
 * under src/observability/__tests__/. Scope:
 * STRYKER_TEST_SCOPE="src/observability/__tests__ src/admin/entities/__tests__".
 *
 * Baseline: 28 mutants, 23 killed / 5 survived. All 5 line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Documented equivalent (verified, not assumed):
 *   42:13-42:31 ConditionalExpression `false` (forces the
 *   `baselineRate === 0 ? true : ...` ternary's condition to always-false, so the
 *   else branch `recentRate >= baselineRate * factor` always runs even when
 *   baselineRate genuinely is 0). Unobservable: `recent.calls`/`baseline.calls`
 *   are SQL `COUNT(*)` results (always >= 0, from usage.ts), and
 *   `config.anomalyRecentWindowMs`/`anomalyBaselineWindowMs` are read via
 *   `Number(process.env.X) || <default>` — the `||` fallback means an
 *   explicit 0 (or unset/NaN) env value can never actually produce a
 *   zero-or-negative window at runtime, only the positive default. With
 *   calls >= 0 and window > 0 always, recentRate is always a finite,
 *   non-negative number. So whenever baselineRate is genuinely 0,
 *   `recentRate >= baselineRate * factor` (`recentRate >= 0`) is ALSO always
 *   true — real code's direct `true` and the mutant's recomputed comparison
 *   agree on every reachable input. No test can distinguish them.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { detectUsageSpike } from "../../../observability/anomaly.js";
import { __clearUsageForTesting } from "../../../observability/usage.js";

function seed(count: number, createdAt: number): void {
  const db = getDb();
  const stmt = db.query(
    `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at) VALUES ('svc','t',NULL,'2xx',0,5,?)`,
  );
  for (let i = 0; i < count; i++) stmt.run(createdAt);
}

const MIN = 60_000;

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
});
afterEach(() => {
  __resetDbForTesting();
});

describe("detectUsageSpike — default-value fallbacks use ?? (not &&)", () => {
  // Kills 22:18-22:34 LogicalOperator (`opts.factor ?? 3` -> `opts.factor && 3`).
  // A truthy explicit factor (5) is returned as-is by `??`; `&&` would instead
  // evaluate to the RIGHT operand (3) since the left is truthy — only
  // observable with a factor that differs from the literal default.
  test("an explicit truthy factor is reflected as-is in the result, not collapsed to the literal default", () => {
    const now = Date.now();
    // No seeded calls at all: recent.calls=0 never reaches minCalls, so `spike`
    // stays false regardless — isolates the `factor` field itself.
    const r = detectUsageSpike({ factor: 5, minCalls: 1_000_000, now });
    expect(r.factor).toBe(5);
  });

  // Kills 23:20-23:39 LogicalOperator (`opts.minCalls ?? 20` -> `opts.minCalls && 20`).
  // A truthy explicit minCalls (50) must be used as-is; `&&` would collapse it
  // to 20, silently lowering the threshold.
  test("an explicit truthy minCalls raises the threshold above the literal default, not collapsed to it", () => {
    const now = Date.now();
    seed(30, now - 1 * MIN); // recent burst: 30 calls, below the real minCalls (50)
    // Real: 30 >= 50 is false -> spike stays false.
    // Mutant (`&&`): minCalls becomes 20 -> 30 >= 20 is true -> baseline is
    // silent (0) -> spike wrongly becomes true.
    const r = detectUsageSpike({ factor: 3, minCalls: 50, now });
    expect(r.spike).toBe(false);
  });
});

describe("detectUsageSpike — exact boundary comparisons", () => {
  // Kills 39:7-39:31 EqualityOperator (`recent.calls >= minCalls` -> `recent.calls > minCalls`).
  test("recent calls exactly equal to minCalls still counts as meeting the threshold", () => {
    const now = Date.now();
    seed(20, now - 1 * MIN); // exactly minCalls, silent baseline
    const r = detectUsageSpike({ factor: 3, minCalls: 20, now });
    // Real: 20 >= 20 true -> baselineRate 0 -> spike true.
    // Mutant (`>`): 20 > 20 false -> spike stays false.
    expect(r.spike).toBe(true);
  });

  // Kills 42:41-42:76 EqualityOperator (`recentRate >= baselineRate * factor` ->
  // `recentRate > baselineRate * factor`).
  test("a recent rate exactly at factor-times the baseline rate still counts as a spike", () => {
    const now = Date.now();
    seed(60, now - 30 * MIN); // baseline: 60 calls over the 60-min baseline window = 1/min
    seed(15, now - 1 * MIN); // recent: 15 calls over the 5-min recent window = 3/min
    // threshold = baselineRate(1) * factor(3) = 3 = recentRate exactly.
    const r = detectUsageSpike({ factor: 3, minCalls: 10, now });
    expect(r.baselineRate).toBe(1);
    expect(r.recentRate).toBe(3);
    // Real: 3 >= 3 true -> spike true. Mutant (`>`): 3 > 3 false -> spike false.
    expect(r.spike).toBe(true);
  });
});
