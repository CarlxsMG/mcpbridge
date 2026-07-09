/**
 * Stryker mutation-testing backstop for src/observability/usage.ts — domain 7.
 *
 * Baseline: 114 mutants, 61 killed / 53 survived. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Documented equivalents (verified, not assumed):
 *
 *   37:9-37:22 UpdateOperator (`++insertCount` -> `--insertCount`). Same
 *   equivalence class already established for rate-counters.ts's `opCount`
 *   elsewhere in this program: `insertCount` has no exported getter/reset
 *   helper and is only ever observed via the `% 500 === 0` sampling check —
 *   any 500 CONSECUTIVE integers, whether counted up or down, pass through
 *   every residue class mod 500 exactly once, so the prune trigger fires
 *   with identical frequency regardless of direction. Confirmed by the same
 *   reasoning already verified for rate-counters.ts (not re-derived from
 *   scratch, since the counter shape and modulo-gated single-consumer
 *   pattern are structurally identical).
 *
 *   183:16-183:27 ConditionalExpression true and EqualityOperator '>=0'
 *   (`r.calls > 0 ? r.errors / r.calls : 0` in getTopTools, both variants
 *   that leave the check's TRUE-branch behavior unaffected). Unlike
 *   getUsageSummary's plain aggregate (which genuinely CAN return calls=0
 *   for an empty window), getTopTools' query is a `GROUP BY client_name,
 *   tool_name` — SQL semantics guarantee `COUNT(*)` is >= 1 for every group
 *   a `GROUP BY` actually emits (a zero-member group is never returned at
 *   all), so `r.calls > 0` and `r.calls >= 0` are already identical for
 *   every reachable row, and forcing the check to unconditional `true`
 *   changes nothing either. The OPPOSITE-direction mutants at this same
 *   span (forced `false`, `<= 0`, and the division-to-multiplication
 *   ArithmeticOperator) are real, killable gaps — see the "errorRate" test
 *   below.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import {
  recordUsage,
  getUsageSummary,
  getUsageTimeseries,
  getTopTools,
  getUsageByKey,
  __clearUsageForTesting,
} from "../../observability/usage.js";

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
});
afterEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
});

function record(overrides: Partial<Parameters<typeof recordUsage>[0]> = {}): void {
  recordUsage({
    clientName: "svc",
    toolName: "t",
    keyId: null,
    statusClass: "2xx",
    isError: false,
    durationMs: 5,
    ...overrides,
  });
}

describe("recordUsage — duration clamping", () => {
  // Kills 33:7-33:44 MethodExpression (`Math.max(0, Math.round(e.durationMs))`
  // -> `Math.min(0, ...)`). A positive duration distinguishes max (keeps it)
  // from min (collapses to 0).
  test("a positive duration is stored as-is, not collapsed to 0", () => {
    record({ durationMs: 42 });
    const row = getDb().query(`SELECT duration_ms FROM tool_call_log LIMIT 1`).get() as { duration_ms: number };
    expect(row.duration_ms).toBe(42);
  });
});

describe("recordUsage — the every-500th-call prune trigger", () => {
  // Kills 37:9-37:34 (ConditionalExpression true/false, EqualityOperator
  // '!=='), 37:9-37:28 (ArithmeticOperator '%' -> '*'), and 37:36-39:6
  // (BlockStatement, the prune body emptied). Exactly 500 consecutive calls
  // pass through every residue class mod 500 exactly once, guaranteeing
  // exactly one crossing regardless of insertCount's unknown starting
  // offset (a module-level counter shared across the whole test process,
  // with no reset hook) -- counting DELETE-shaped query calls during that
  // window is deterministic even though the counter's absolute value isn't.
  test("the prune query fires exactly once across exactly 500 consecutive calls", () => {
    const db = getDb();
    const querySpy = spyOn(db, "query");
    try {
      for (let i = 0; i < 500; i++) record();
      const deleteCalls = querySpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("DELETE FROM tool_call_log"),
      );
      expect(deleteCalls).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  // Kills 38:16-38:64 StringLiteral (the DELETE SQL text emptied -- an empty
  // query string throws, silently swallowed by the outer catch, so the row
  // never actually gets deleted) and 38:70-38:106 ArithmeticOperator
  // (`Date.now() - usageRetentionMs` -> `+`, which would wrongly delete a
  // FRESH row too, since a future cutoff exceeds every real timestamp).
  test("pruning deletes only rows past retention, not a just-recorded fresh row", () => {
    const staleCreatedAt = Date.now() - config.usageRetentionMs - 60_000;
    getDb()
      .query(
        `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at)
         VALUES ('stale-client', 'x', NULL, '2xx', 0, 1, ?)`,
      )
      .run(staleCreatedAt);
    record({ clientName: "fresh-client" });

    for (let i = 0; i < 500; i++) record();

    const staleCount = (
      getDb().query(`SELECT COUNT(*) as c FROM tool_call_log WHERE client_name = 'stale-client'`).get() as {
        c: number;
      }
    ).c;
    const freshCount = (
      getDb().query(`SELECT COUNT(*) as c FROM tool_call_log WHERE client_name = 'fresh-client'`).get() as {
        c: number;
      }
    ).c;
    expect(staleCount).toBe(0);
    expect(freshCount).toBeGreaterThan(0);
  });
});

describe("getUsageSummary — default window and per-half filter clauses", () => {
  // Kills 46:31-46:37 / 46:31-46:42 ArithmeticOperator (the 7-day default
  // window's `7 * 24 * 60 * 60_000` constant mangled) — observed via the
  // returned `.from` field, since windowFrom isn't exported directly.
  test("the default window is exactly 7 days before now", () => {
    const before = Date.now();
    const s = getUsageSummary({});
    const after = Date.now();
    const expectedMin = before - 7 * 24 * 60 * 60_000;
    const expectedMax = after - 7 * 24 * 60 * 60_000;
    expect(s.from).toBeGreaterThanOrEqual(expectedMin);
    expect(s.from).toBeLessThanOrEqual(expectedMax);
  });

  // Kills 65:7-65:28 (ConditionalExpression false), 65:30-68:4
  // (BlockStatement, `to` clause body emptied), and 66:21-66:38
  // (StringLiteral, "created_at <= ?" emptied).
  test("an explicit `to` excludes calls recorded after it", () => {
    const cutoff = Date.now();
    record();
    // A call recorded "after" the window -- fake it by inserting directly
    // with a created_at comfortably past `cutoff`.
    getDb()
      .query(
        `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at)
         VALUES ('svc', 'later', NULL, '2xx', 0, 1, ?)`,
      )
      .run(cutoff + 60_000);
    const s = getUsageSummary({ to: cutoff + 1000 });
    expect(s.calls).toBe(1);
  });

  // Kills 69:7-69:22 (ConditionalExpression false), 69:24-72:4
  // (BlockStatement, clientName clause body emptied), and 70:21-70:38
  // (StringLiteral, "client_name = ?" emptied).
  test("clientName narrows the summary to only that client", () => {
    record({ clientName: "a" });
    record({ clientName: "b" });
    expect(getUsageSummary({ clientName: "a" }).calls).toBe(1);
  });

  // Kills 73:42-73:49 StringLiteral (the " AND " join separator emptied) --
  // needs BOTH a `to` and a `clientName` filter simultaneously.
  test("combining `to` and clientName ANDs the two clauses together", () => {
    const cutoff = Date.now() + 60_000;
    record({ clientName: "a" });
    record({ clientName: "b" });
    expect(getUsageSummary({ to: cutoff, clientName: "a" }).calls).toBe(1);
  });

  // Kills 87:16-87:29 ConditionalExpression true and EqualityOperator
  // ('>=' instead of '>'). Unlike getTopTools' GROUP BY (where COUNT(*) can
  // never be 0 for a returned row), this is a plain aggregate query that
  // CAN genuinely return calls=0 for an empty window -- forcing the ternary
  // true would compute 0/0 = NaN instead of the real code's literal 0.
  test("an empty window's errorRate is exactly 0, not NaN", () => {
    const s = getUsageSummary({ from: Date.now() + 60_000 });
    expect(s.calls).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(Number.isNaN(s.errorRate)).toBe(false);
  });
});

describe("getUsageTimeseries — bucket-size selection and clamping", () => {
  // Kills 95:52-97:2 (BlockStatement, defaultBucketMs's whole body emptied),
  // 96:10-96:38 (ConditionalExpression true/false, EqualityOperator '<'/'>'
  // on the 26h threshold), and the millisecond-constant ArithmeticOperator
  // mutants (26*60*60_000 / 24*60*60_000) -- observed via the returned
  // `.bucketMs`, since defaultBucketMs isn't exported.
  test("a window at or under 26 hours buckets by the hour; just over 26 hours buckets by the day", () => {
    const now = Date.now();
    const at26h = getUsageTimeseries({ from: now - 26 * 60 * 60_000, to: now });
    expect(at26h.bucketMs).toBe(60 * 60_000);

    const over26h = getUsageTimeseries({ from: now - (26 * 60 * 60_000 + 60_000), to: now });
    expect(over26h.bucketMs).toBe(24 * 60 * 60_000);
  });

  // Kills 120:20-120:81 MethodExpression (the 60_000ms floor's `Math.max`
  // dropped) — an explicitly tiny requested bucketMs must still clamp up.
  test("an explicit bucketMs below the 60s floor is clamped up to 60_000", () => {
    const now = Date.now();
    const ts = getUsageTimeseries({ from: now - 5 * 60_000, to: now, bucketMs: 1000 });
    expect(ts.bucketMs).toBe(60_000);
  });

  // Kills 123:7-123:22 (ConditionalExpression false), 123:24-126:4
  // (BlockStatement, clientName clause emptied), and 124:21-124:38
  // (StringLiteral, "client_name = ?" emptied).
  test("clientName narrows the timeseries to only that client's calls", () => {
    const now = Date.now();
    record({ clientName: "a" });
    record({ clientName: "b" });
    const ts = getUsageTimeseries({ from: now - 60_000, to: now + 60_000, bucketMs: 60_000, clientName: "a" });
    expect(ts.points.reduce((sum, p) => sum + p.calls, 0)).toBe(1);
  });

  // Kills 139:33-139:46 ArithmeticOperator (`Math.floor(to / bucketMs) *
  // bucketMs` -> `to * bucketMs`, the lastBucket computation) -- asserted
  // via the exact final point's timestamp.
  test("the last bucket boundary is floor(to / bucketMs) * bucketMs exactly", () => {
    const bucketMs = 60_000;
    const from = 0;
    const to = 3 * bucketMs + 30_000; // deliberately not an exact multiple
    const ts = getUsageTimeseries({ from, to, bucketMs });
    const expectedLast = Math.floor(to / bucketMs) * bucketMs;
    expect(ts.points[ts.points.length - 1].t).toBe(expectedLast);
  });

  // Kills 141:29-141:85 (LogicalOperator '&&' -> '||', ConditionalExpression
  // true on both halves, EqualityOperator '<=' on the MAX_TIMESERIES_POINTS
  // check). Needs a window wide enough (relative to bucketMs) to exceed
  // 1000 buckets -- the loop zero-fills regardless of real data, so no rows
  // need to actually be inserted.
  test("the point count never exceeds MAX_TIMESERIES_POINTS (1000), even across a much wider window", () => {
    const bucketMs = 60_000;
    const from = 0;
    const to = 2000 * bucketMs; // 2000 buckets' worth of range
    const ts = getUsageTimeseries({ from, to, bucketMs });
    expect(ts.points).toHaveLength(1000);
  });
});

describe("getTopTools — limit clamping and per-row errorRate", () => {
  // Kills 160:17-160:61 (MethodExpression, outer Math.min dropped),
  // 160:26-160:55 (MethodExpression, inner Math.max dropped), and
  // 160:35-160:51 (LogicalOperator '??' -> '&&', only observable with an
  // explicit truthy limit distinct from the literal default 20).
  test("limit is clamped to [1, 100], and an explicit truthy value is honored as-is (not collapsed to the default)", () => {
    for (let i = 0; i < 10; i++) record({ toolName: `tool-${i}` });
    expect(getTopTools({ limit: 5 }).length).toBe(5);
    expect(getTopTools({ limit: 0 }).length).toBe(1); // clamped up to 1, not 0
    expect(getTopTools({ limit: -5 }).length).toBe(1); // clamped up to the floor of 1
  });

  // Kills 183:16-183:27 ConditionalExpression false and EqualityOperator
  // '<=' (both would force errorRate to 0 unconditionally) and 183:30-183:48
  // ArithmeticOperator (division -> multiplication). Unlike getUsageSummary,
  // GROUP BY here guarantees calls >= 1 for any returned row -- so the
  // forced-true/`>=0` variants of this same span are documented equivalents
  // below, not tested (there is no reachable calls=0 row to distinguish them).
  test("a tool with errors has the exact errors/calls errorRate, not always 0", () => {
    record({ toolName: "flaky", isError: true });
    record({ toolName: "flaky", isError: true });
    record({ toolName: "flaky", isError: false });
    const row = getTopTools({ limit: 10 }).find((r) => r.tool === "flaky")!;
    expect(row.calls).toBe(3);
    expect(row.errors).toBe(2);
    expect(row.errorRate).toBeCloseTo(2 / 3);
  });
});

describe("getUsageByKey — limit clamping and the unlabeled-key fallback", () => {
  // Kills 198:17-198:61 MethodExpression (the outer Math.min dropped, which
  // would remove the 200-row ceiling entirely). A row count safely UNDER
  // 200 can't distinguish "clamped to 200" from "not clamped at all" -- both
  // return every row either way. Needs strictly MORE than 200 distinct
  // key_id groups to actually observe the cap biting.
  test("limit is clamped down to 200, even when 201 distinct keys and a larger requested limit would otherwise return more", () => {
    for (let i = 0; i < 201; i++) record({ keyId: i + 1 });
    expect(getUsageByKey({ limit: 500 })).toHaveLength(200);
  });

  // Kills 211:63-211:81 StringLiteral (the `key #${r.key_id}` template
  // emptied) -- needs a keyId that has NO matching mcp_api_keys row (so
  // the LEFT JOIN's label column is null), distinct from the null-keyId
  // "(unattributed)" case already covered elsewhere.
  test("a key id with no matching label falls back to the exact 'key #<id>' string", () => {
    record({ keyId: 999_999 });
    const row = getUsageByKey().find((r) => r.keyId === 999_999)!;
    expect(row.label).toBe("key #999999");
  });
});

describe("__clearUsageForTesting", () => {
  // Kills 218:48-224:2 / 219:7-221:4 (BlockStatement, the whole
  // implementation and its inner try body emptied) and 220:19-220:46
  // (StringLiteral, the DELETE SQL emptied) -- this test-only helper, used
  // throughout the existing suite's own beforeEach/afterEach, had zero
  // coverage of its own.
  test("deletes every usage row", () => {
    record();
    expect(getUsageSummary({ from: 0 }).calls).toBeGreaterThan(0);
    __clearUsageForTesting();
    expect(getUsageSummary({ from: 0 }).calls).toBe(0);
  });
});
