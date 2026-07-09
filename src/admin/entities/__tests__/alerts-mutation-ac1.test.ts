/**
 * Stryker mutation-testing backstop for src/observability/alerts.ts — cluster ac1
 * (top-of-file data + simple CRUD, lines 1-139). Test dir is CROSS-DIRECTORY (same
 * convention as this file's sibling anomaly-mutation.test.ts / monitor-mutation.test.ts,
 * and the existing dedicated alerts.test.ts): the source lives at
 * src/observability/alerts.ts but its tests live under src/admin/entities/__tests__/.
 *
 * Baseline: reports/mutation/result.json, 161 total mutants for this file, 91 survived.
 * Of those, 16 fall in this cluster's line range (1-139) and are targeted below. Every
 * id/line:col/mutatorName/replacement citation was read directly from that report
 * (mutants array filtered to location.start.line in [1,139] and status !== "Killed"),
 * not transcribed from prose.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../../../db/connection.js";
import {
  ALERT_EVENT_TYPES,
  createAlertRule,
  getAlertRule,
  updateAlertRule,
  deleteAlertRule,
} from "../../../observability/alerts.js";

beforeEach(() => {
  __resetDbForTesting();
});
afterEach(() => {
  __resetDbForTesting();
});

describe("ALERT_EVENT_TYPES — exact literal contents", () => {
  // Kills id=0 (14:52-20:2 ArrayDeclaration -> `[]`) and ids=1..5 (StringLiteral ->
  // `""` at 15:3-25 "circuit_breaker_open", 16:3-23 "client_unreachable",
  // 17:3-15 "error_rate", 18:3-16 "usage_spike", 19:3-17 "schema_drift").
  // A single exact toEqual against the full, ordered list distinguishes every one
  // of these mutants: an emptied array or any single blanked entry no longer
  // matches.
  test("is exactly the five known event type strings, in order", () => {
    expect(ALERT_EVENT_TYPES).toEqual([
      "circuit_breaker_open",
      "client_unreachable",
      "error_rate",
      "usage_spike",
      "schema_drift",
    ]);
  });
});

describe("getAlertRule — Number.isInteger guard", () => {
  // Kills 78:7-28 ConditionalExpression (`!Number.isInteger(id)` -> `false`).
  // Empirically verified (scratch probe against bun:sqlite): a bound TEXT
  // parameter like "1" is coerced by SQLite's column-affinity rules and DOES
  // match an INTEGER PRIMARY KEY column holding 1 — so if the guard were
  // skipped, the query underneath would actually find the row. Real code must
  // reject the non-integer id *before* that query ever runs.
  test("rejects a numeric-string id even though the DB would match it by affinity if queried", () => {
    const r = createAlertRule({
      name: "cb",
      eventType: "circuit_breaker_open",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: null,
      actor: "t",
    });
    const result = getAlertRule(String(r.id) as unknown as number);
    expect(result).toBeNull();
  });
});

describe("updateAlertRule — existing-row guard", () => {
  // Kills 122:7-16 ConditionalExpression (`!existing` -> `false`). If the guard
  // is skipped, real code would instead crash dereferencing `existing.name` /
  // `.enabled` / etc. on `null` a few lines down — this test pins the documented
  // contract (return null, don't throw) for an id that doesn't exist.
  test("returns null for a non-existent id instead of throwing", () => {
    expect(updateAlertRule(999_999, { enabled: false })).toBeNull();
  });
});

describe("updateAlertRule — partial-update merge logic", () => {
  // Kills 124:19-54 LogicalOperator (`updates.enabled ?? existing.enabled` ->
  // `updates.enabled && existing.enabled`). `??` and `&&` agree whenever the
  // left operand is falsy, so the distinguishing case needs updates.enabled to
  // be explicitly `true` while the *existing* row is currently disabled:
  // `true ?? false` -> true (real), `true && false` -> false (mutant).
  test("re-enabling a disabled rule takes effect (not ANDed against the still-stale existing value)", () => {
    const r = createAlertRule({
      name: "cb",
      eventType: "circuit_breaker_open",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: null,
      actor: "t",
    });
    updateAlertRule(r.id, { enabled: false });
    const result = updateAlertRule(r.id, { enabled: true });
    expect(result?.enabled).toBe(true);
  });

  // Kills 126:21-52 ConditionalExpression -> `false` (id=26) and EqualityOperator
  // -> `updates.threshold === undefined` (id=27). Both mutants make an explicitly
  // provided threshold get silently discarded in favor of the stale existing
  // value; a defined update must win.
  test("an explicitly provided threshold overrides the existing stored value", () => {
    const r = createAlertRule({
      name: "err",
      eventType: "error_rate",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: 10,
      minCalls: null,
      actor: "t",
    });
    const result = updateAlertRule(r.id, { threshold: 42 });
    expect(result?.threshold).toBe(42);
  });

  // Kills 126:21-52 ConditionalExpression -> `true` (id=25). That mutant makes
  // the ternary *always* take the `updates.threshold` branch, even when it's
  // `undefined` (field omitted from the partial update) — silently clobbering
  // the existing value with `undefined`/null instead of preserving it.
  test("omitting threshold from a partial update preserves the existing stored value", () => {
    const r = createAlertRule({
      name: "err",
      eventType: "error_rate",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: 7,
      minCalls: null,
      actor: "t",
    });
    const result = updateAlertRule(r.id, { name: "err-renamed" });
    expect(result?.threshold).toBe(7);
  });

  // Kills 127:20-50 ConditionalExpression -> `false` (id=29) and EqualityOperator
  // -> `updates.minCalls === undefined` (id=30). Mirror of the threshold-override
  // case above, for minCalls.
  test("an explicitly provided minCalls overrides the existing stored value", () => {
    const r = createAlertRule({
      name: "err",
      eventType: "error_rate",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: 10,
      actor: "t",
    });
    const result = updateAlertRule(r.id, { minCalls: 99 });
    expect(result?.minCalls).toBe(99);
  });

  // Kills 127:20-50 ConditionalExpression -> `true` (id=28). Mirror of the
  // threshold-omission case above, for minCalls.
  test("omitting minCalls from a partial update preserves the existing stored value", () => {
    const r = createAlertRule({
      name: "err",
      eventType: "error_rate",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: 15,
      actor: "t",
    });
    const result = updateAlertRule(r.id, { name: "err-renamed" });
    expect(result?.minCalls).toBe(15);
  });
});

describe("deleteAlertRule — affected-rows check", () => {
  // Kills 138:10-83 EqualityOperator (`.changes > 0` -> `.changes >= 0`).
  // Deleting an id that was never inserted produces `changes === 0`; real code
  // must report failure (false), while the mutant would report success (true)
  // since 0 >= 0.
  test("returns false when no row matched the given id", () => {
    expect(deleteAlertRule(999_999)).toBe(false);
  });
});
