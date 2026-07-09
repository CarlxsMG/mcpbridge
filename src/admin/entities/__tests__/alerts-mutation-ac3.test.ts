/**
 * Stryker mutation-testing backstop for src/observability/alerts.ts — cluster ac3:
 * evaluateCondition's "error_rate" switch case (lines 161-167) — the densest single
 * case in the file (getUsageSummary window computation, threshold/minCalls defaults
 * via `??`, and the compound `active = calls>=minCalls && errorRate>=threshold`
 * check). Test dir is CROSS-DIRECTORY (same convention as this file's dedicated
 * test, alerts.test.ts, and sibling files anomaly-mutation.test.ts/
 * monitor-mutation.test.ts): alerts.ts lives at src/observability/alerts.ts but its
 * tests live at src/admin/entities/__tests__/.
 *
 * All 18 mutant IDs/line:cols below were read directly from
 * reports/mutation/result.json (filtered to location.start.line in [161,167] and
 * status !== "Killed"), not transcribed from prose. All 18 are genuinely killable
 * (no equivalents documented in this cluster) — see per-test comments for exact
 * IDs.
 *
 * evaluateCondition itself is not exported, so every test drives it indirectly via
 * evaluateAlerts() + a spy on the (named-import, live-binding) dispatchWebhook
 * export — the same technique already proven for this exact case in
 * monitor-mutation.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { __clearUsageForTesting } from "../../../observability/usage.js";
import { createAlertRule, evaluateAlerts, __resetAlertStateForTesting } from "../../../observability/alerts.js";
import * as webhookMod from "../../../lib/webhook.js";

const MIN = 60_000;
const originalAlertErrorRateWindowMs = config.alertErrorRateWindowMs;

/** Seeds `total` tool_call_log rows (with `errors` of them marked is_error) at a fixed timestamp. */
function seedCalls(total: number, errors: number, createdAt: number): void {
  const db = getDb();
  const errStmt = db.query(
    `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at) VALUES ('svc','t',NULL,'5xx',1,5,?)`,
  );
  const okStmt = db.query(
    `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at) VALUES ('svc','t',NULL,'2xx',0,5,?)`,
  );
  for (let i = 0; i < errors; i++) errStmt.run(createdAt);
  for (let i = 0; i < total - errors; i++) okStmt.run(createdAt);
}

function makeErrorRateRule(threshold: number | null, minCalls: number | null) {
  return createAlertRule({
    name: "err",
    eventType: "error_rate",
    webhookUrl: "http://127.0.0.1:9/hook",
    threshold,
    minCalls,
    actor: null,
  });
}

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
  __resetAlertStateForTesting();
});
afterEach(() => {
  (config as Record<string, unknown>).alertErrorRateWindowMs = originalAlertErrorRateWindowMs;
});

describe("evaluateCondition — error_rate case is reached intact (not erased/mismatched)", () => {
  // Kills:
  //   71  161:5-167:6   ConditionalExpression -> `case "error_rate":` (whole case
  //       clause body dropped, falling through into the next case, "usage_spike")
  //   72  161:10-161:22 StringLiteral          -> `""` (case label no longer
  //       matches eventType "error_rate" at all -> falls to `default`)
  //   73  161:24-167:6  BlockStatement         -> `{}` (case matches but its body
  //       is emptied, again falling through into "usage_spike")
  //   75  162:47-162:89 ArithmeticOperator     -> `Date.now() + ...windowMs` (the
  //       window's `from` moves into the FUTURE, excluding every seeded row)
  //   87  166:14-166:109 ObjectLiteral         -> `{}` (return value itself erased)
  //   88  166:32-166:107 ObjectLiteral         -> `{}` (only `detail` erased)
  // All six collapse this scenario's exact `detail` shape and/or `active`/firing
  // behavior into something different from the real, fully-computed result.
  test("fires once with the exact errorRate/calls/threshold/minCalls detail payload", async () => {
    const now = Date.now();
    seedCalls(20, 15, now - 1000); // 20 calls, 15 errors -> errorRate 0.75, well inside default 5-min window
    makeErrorRateRule(null, null); // defaults: threshold 0.5, minCalls 10
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0]?.[1] as { detail: Record<string, unknown> };
      expect(payload.detail).toEqual({ errorRate: 0.75, calls: 20, threshold: 0.5, minCalls: 10 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — error_rate uses its OWN window, not the 7-day usage default", () => {
  // Kills 74  162:39-162:91  ObjectLiteral -> `{}` (the `{ from: ... }` argument to
  // getUsageSummary is erased, silently falling back to getUsageSummary's own
  // 7-day default window instead of config.alertErrorRateWindowMs).
  test("calls outside the configured window are excluded, even though they're inside the 7-day usage default", async () => {
    (config as Record<string, unknown>).alertErrorRateWindowMs = 1 * MIN;
    const now = Date.now();
    seedCalls(15, 15, now - 3 * MIN); // 3 min ago: outside the 1-min alert window, inside the 7-day usage default
    makeErrorRateRule(null, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      // Real: from = now-1min excludes the 3-min-old rows -> calls=0 -> 0>=10 false -> never fires.
      // Mutant: argument {} -> 7-day window includes them -> calls=15, errorRate=1 -> fires.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — threshold/minCalls defaults use ?? (not &&)", () => {
  // Kills 76  163:25-163:46  LogicalOperator -> `rule.threshold && 0.5`. A truthy
  // explicit threshold (0.9) is used as-is by `??`; `&&` would instead collapse it
  // to the literal default (0.5) since the left operand is truthy.
  test("an explicit truthy threshold is reflected as-is, not collapsed to the literal default", async () => {
    const now = Date.now();
    seedCalls(20, 20, now - 1000); // errorRate 1.0 clears either 0.9 (real) or 0.5 (mutant) threshold either way
    makeErrorRateRule(0.9, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0]?.[1] as { detail: Record<string, unknown> };
      expect(payload.detail.threshold).toBe(0.9);
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 77  164:24-164:43  LogicalOperator -> `rule.minCalls && 10`. A truthy
  // explicit minCalls (7) must be used as-is; `&&` collapses it to 10, which here
  // would additionally flip `active` from true to false (8 calls >= 7 but not >= 10).
  test("an explicit truthy minCalls is reflected as-is and actually gates firing, not collapsed to the literal default", async () => {
    const now = Date.now();
    seedCalls(8, 8, now - 1000); // 8 calls, all errors -> clears minCalls=7 (real) but not the mutant's forced 10
    makeErrorRateRule(null, 7);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0]?.[1] as { detail: Record<string, unknown> };
      expect(payload.detail.minCalls).toBe(7);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — active is an exact >= / && comparison, not >, <, ||, or a forced constant", () => {
  // Boundary: calls exactly equal to minCalls (10), errorRate well above threshold.
  // Kills:
  //   79  165:22-165:81 ConditionalExpression -> `false` (whole expr forced false;
  //       real is true here)
  //   82  165:22-165:47 EqualityOperator -> `summary.calls > minCalls` (10 > 10 is
  //       false; real >= is true)
  //   83  165:22-165:47 EqualityOperator -> `summary.calls < minCalls` (10 < 10 is
  //       false; real >= is true)
  //   86  165:51-165:81 EqualityOperator -> `summary.errorRate < threshold` (1.0 <
  //       0.5 is false; real >= is true)
  test("calls exactly at minCalls with a high error rate still fires (>= not > or <)", async () => {
    const now = Date.now();
    seedCalls(10, 10, now - 1000); // calls === minCalls(10) exactly, errorRate 1.0 >> threshold 0.5
    makeErrorRateRule(null, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Boundary: errorRate exactly equal to threshold (0.5), calls comfortably above minCalls.
  // Kills 85  165:51-165:81 EqualityOperator -> `summary.errorRate > threshold`
  // (0.5 > 0.5 is false; real >= is true).
  test("an error rate exactly at the threshold still fires (>= not >)", async () => {
    const now = Date.now();
    seedCalls(20, 10, now - 1000); // errorRate 10/20 = 0.5 === threshold exactly; calls 20 >> minCalls 10
    makeErrorRateRule(null, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // calls comfortably >= minCalls (left true) but errorRate well below threshold
  // (right false) -> real active is false.
  // Kills:
  //   78  165:22-165:81 ConditionalExpression -> `true` (whole expr forced true)
  //   80  165:22-165:81 LogicalOperator -> `||` (true || false = true; real && is false)
  //   84  165:51-165:81 ConditionalExpression -> `true` (right side forced true)
  test("calls above minCalls but a low error rate does not fire (&& requires both, not either)", async () => {
    const now = Date.now();
    seedCalls(20, 2, now - 1000); // calls 20 >= minCalls 10 (true); errorRate 0.1 >= threshold 0.5 (false)
    makeErrorRateRule(null, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // calls below minCalls (left false) but errorRate well above threshold (right
  // true) -> real active is false.
  // Kills 81  165:22-165:47 ConditionalExpression -> `true` (left side forced
  // true; combined with the real-true right side this would wrongly fire).
  test("a high error rate below minCalls does not fire (both sides of && are real, neither is a forced true)", async () => {
    const now = Date.now();
    seedCalls(5, 5, now - 1000); // calls 5 < minCalls 10 (false); errorRate 1.0 >= threshold 0.5 (true)
    makeErrorRateRule(null, null);
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
