/**
 * The `tool_call_log` write batch (W2-C remedy b) and the bounded retention prune.
 *
 * Every test here reads the table with RAW SQL on purpose: the whole question is
 * what has actually reached SQLite, and going through `getUsageSummary` would
 * flush first and hide the answer.
 *
 * Ambient state matters (one process, one connection, one config for the whole
 * backend suite): `__resetDbForTesting()` gives a fresh `:memory:` database and
 * `__clearUsageForTesting()` drops both the write buffer and any prune timer that
 * an earlier test in this file left armed. Seeding happens per-test, never in a
 * `beforeAll`, because the preloaded isolation hook resets before EVERY test.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import {
  recordUsage,
  flushUsageLog,
  pruneUsageLogOnce,
  getUsageSummary,
  USAGE_LOG_BATCH_MAX_ROWS,
  USAGE_PRUNE_MAX_ROWS_PER_PASS,
  __clearUsageForTesting,
} from "../usage.js";
import { createConsumer, getConsumerUsageThisMonth } from "../../admin/entities/consumers.js";
import { createMcpKey } from "../../security/mcp-key-store.js";

beforeEach(() => {
  __resetDbForTesting();
  __clearUsageForTesting();
});
afterEach(() => {
  __clearUsageForTesting();
  __resetDbForTesting();
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

/** Rows physically present in tool_call_log — buffered rows are deliberately NOT counted. */
function persistedRows(): number {
  return (getDb().query(`SELECT COUNT(*) as c FROM tool_call_log`).get() as { c: number }).c;
}

describe("tool_call_log write batching", () => {
  test("rows accumulate in the buffer and land in one go once the batch is full", () => {
    for (let i = 0; i < USAGE_LOG_BATCH_MAX_ROWS - 1; i++) record();
    // Still buffered: nothing has crossed the threshold and the turn has not ended.
    expect(persistedRows()).toBe(0);

    record();
    expect(persistedRows()).toBe(USAGE_LOG_BATCH_MAX_ROWS);
  });

  test("a full batch is written as ONE statement, so the fsync is amortised", () => {
    // The amortisation is the point of the change: N rows must not become N
    // autocommits. Counting rows can't see that, so count the INSERTs instead —
    // one multi-row statement for the whole batch.
    const db = getDb();
    const querySpy = spyOn(db, "query");
    let logInserts: number;
    try {
      for (let i = 0; i < USAGE_LOG_BATCH_MAX_ROWS; i++) record();
      logInserts = querySpy.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO tool_call_log"),
      ).length;
    } finally {
      querySpy.mockRestore();
    }
    expect(logInserts).toBe(1);
    expect(persistedRows()).toBe(USAGE_LOG_BATCH_MAX_ROWS);
  });

  test("every buffered row survives the batch with its own field values intact", () => {
    record({ clientName: "a", toolName: "one", statusClass: "2xx", isError: false, durationMs: 11 });
    record({ clientName: "b", toolName: "two", statusClass: "5xx", isError: true, durationMs: 22 });
    flushUsageLog();
    const rows = getDb()
      .query(`SELECT client_name, tool_name, status_class, is_error, duration_ms FROM tool_call_log ORDER BY id`)
      .all() as {
      client_name: string;
      tool_name: string;
      status_class: string;
      is_error: number;
      duration_ms: number;
    }[];
    expect(rows).toEqual([
      { client_name: "a", tool_name: "one", status_class: "2xx", is_error: 0, duration_ms: 11 },
      { client_name: "b", tool_name: "two", status_class: "5xx", is_error: 1, duration_ms: 22 },
    ]);
  });

  test("a read flushes first, so a call is visible to the very next query (the freshness guarantee)", () => {
    record();
    // Buffered, not yet in SQLite...
    expect(persistedRows()).toBe(0);
    // ...but a reader must never see a stale window. This is the discriminating
    // assertion for the flush-on-read hook: without it the summary reports 0.
    expect(getUsageSummary({ from: 0 }).calls).toBe(1);
    expect(persistedRows()).toBe(1);
  });

  test("a buffered row never survives past the end of the event-loop turn", async () => {
    record();
    expect(persistedRows()).toBe(0);
    await Promise.resolve();
    expect(persistedRows()).toBe(1);
  });

  test("flushUsageLog is idempotent and safe with an empty buffer", () => {
    flushUsageLog();
    expect(persistedRows()).toBe(0);
    record();
    flushUsageLog();
    flushUsageLog();
    expect(persistedRows()).toBe(1);
  });

  test("graceful shutdown flushes the buffer", () => {
    // The wiring itself lives in src/index.ts, which cannot be imported here
    // (importing it boots the server and binds a port), so assert structurally
    // that gracefulShutdown calls the flush. What would break this: moving the
    // call out of that function, which is exactly the regression that would
    // silently drop a batch on every deploy.
    const src = readFileSync(join(import.meta.dir, "..", "..", "index.ts"), "utf8");
    const body = src.slice(src.indexOf("async function gracefulShutdown"));
    const end = body.indexOf("\n}\n");
    expect(end).toBeGreaterThan(0);
    expect(body.slice(0, end)).toContain("flushUsageLog()");
  });
});

describe("the consumer quota counter is NOT deferred", () => {
  test("a quota-relevant write is durable and readable immediately, while the log row is still buffered", () => {
    const c = createConsumer({ name: "team-a", monthlyQuota: 100, actor: null });
    const { record: key } = createMcpKey("k", null, null, null, c.id);

    record({ keyId: key.id });

    // The analytics row is buffered...
    expect(persistedRows()).toBe(0);
    // ...but the quota row that checkConsumerQuota enforces against is already
    // committed. Deferring it would let a consumer overshoot by a whole batch.
    const counter = getDb().query(`SELECT count FROM consumer_usage_counters WHERE consumer_id = ?`).get(c.id) as {
      count: number;
    } | null;
    expect(counter?.count).toBe(1);
    expect(getConsumerUsageThisMonth(c.id)).toBe(1);
  });
});

/** Seeds `n` tool_call_log rows already past the retention window, in one statement. */
function seedExpiredRows(n: number): void {
  const createdAt = Date.now() - config.usageRetentionMs - 60_000;
  getDb()
    .query(
      `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at)
       SELECT 'old', 't', NULL, '2xx', 0, 1, ?
       FROM (WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?) SELECT i FROM seq)`,
    )
    .run(createdAt, n);
}

describe("retention prune — bounded work per pass", () => {
  test("one pass deletes at most the per-pass limit, however far behind retention is", () => {
    const backlog = USAGE_PRUNE_MAX_ROWS_PER_PASS * 2 + 1;
    seedExpiredRows(backlog);
    expect(persistedRows()).toBe(backlog);

    // Asserting the row bound, not a wall-clock duration: a timing assertion is
    // flaky on a loaded machine, and the bound is what actually keeps the stall
    // proportional to the limit instead of to the size of the backlog.
    expect(pruneUsageLogOnce()).toBe(USAGE_PRUNE_MAX_ROWS_PER_PASS);
    expect(persistedRows()).toBe(backlog - USAGE_PRUNE_MAX_ROWS_PER_PASS);

    expect(pruneUsageLogOnce()).toBe(USAGE_PRUNE_MAX_ROWS_PER_PASS);
    expect(pruneUsageLogOnce()).toBe(1);
    expect(persistedRows()).toBe(0);
  });

  test("a pass with nothing expired deletes nothing and leaves fresh rows alone", () => {
    record({ clientName: "fresh" });
    flushUsageLog();
    expect(pruneUsageLogOnce()).toBe(0);
    expect(persistedRows()).toBe(1);
  });

  test("a pass deletes only expired rows, never a fresh one recorded alongside them", () => {
    seedExpiredRows(3);
    record({ clientName: "fresh" });
    flushUsageLog();

    expect(pruneUsageLogOnce()).toBe(3);
    const rows = getDb().query(`SELECT client_name FROM tool_call_log`).all() as { client_name: string }[];
    expect(rows).toEqual([{ client_name: "fresh" }]);
  });
});
