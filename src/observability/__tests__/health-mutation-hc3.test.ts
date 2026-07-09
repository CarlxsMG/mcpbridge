/**
 * Stryker mutation backstop — cluster hc3
 *
 * Target: src/observability/health.ts lines 56-72 — the non-ok-response
 * failure path inside checkBatch's per-client REST check (metrics +
 * handleFailure call), and the catch block wrapping the whole per-client
 * check (a thrown fetch error -> metrics + a log("warn", "Health check
 * failed", {...}) call + handleFailure call).
 *
 * Ground truth re-queried directly from reports/mutation/result.json,
 * filtered to mutants whose location.start.line is in [56,72] and whose
 * status is NOT "Killed" (all 16 came back "Survived", none "Timeout"):
 *
 *   id 39  ObjectLiteral        56:41-56:84   { client, outcome: "failure" } -> {}       (duration.observe labels, else-branch)
 *   id 40  StringLiteral        56:73-56:82   "failure" -> ""                            (outcome value, else-branch duration)
 *   id 41  ArithmeticOperator   56:86-56:115  (Date.now()-hcStart)/1000 -> ...*1000       (else-branch duration, outer / -> *)
 *   id 42  ArithmeticOperator   56:87-56:107  Date.now()-hcStart -> Date.now()+hcStart    (else-branch duration, inner - -> +)
 *   id 43  ObjectLiteral        57:38-57:60   { outcome: "failure" } -> {}                (runsTotal.inc labels, else-branch)
 *   id 44  StringLiteral        57:49-57:58   "failure" -> ""                             (outcome value, else-branch counter)
 *   id 45  BlockStatement       60:25-68:10   entire catch block -> {}                     (whole catch body wiped)
 *   id 46  ObjectLiteral        61:39-61:82   { client, outcome: "failure" } -> {}          (duration.observe labels, catch)
 *   id 47  StringLiteral        61:71-61:80   "failure" -> ""                              (outcome value, catch duration)
 *   id 48  ArithmeticOperator   61:84-61:113  (Date.now()-hcStart)/1000 -> ...*1000        (catch duration, outer / -> *)
 *   id 49  ArithmeticOperator   61:85-61:105  Date.now()-hcStart -> Date.now()+hcStart     (catch duration, inner - -> +)
 *   id 50  ObjectLiteral        62:36-62:58   { outcome: "failure" } -> {}                 (runsTotal.inc labels, catch)
 *   id 51  StringLiteral        62:47-62:56   "failure" -> ""                              (outcome value, catch counter)
 *   id 52  StringLiteral        63:15-63:21   "warn" -> ""                                 (log level arg)
 *   id 53  StringLiteral        63:23-63:44   "Health check failed" -> ""                  (log message arg)
 *   id 54  ObjectLiteral        63:46-66:12   { client, error } -> {}                      (log meta arg)
 *
 * No equivalents in this cluster — all 16 mutants are killed below by real,
 * targeted tests (no reasoning-only equivalence claims needed for hc3).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import * as loggerMod from "../../logger.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { refreshLeaderStatus } from "../../db/leader-lease.js";
import { healthCheckDuration, healthCheckRunsTotal } from "../metrics.js";
import { startHealthCheckLoop } from "../health.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
  };
}

async function registerClient(name: string) {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the current `_sum`/`_count` for a specific `{client="X",outcome="failure"}`
 * series out of a Histogram's render() text. The metrics.ts renderer always emits
 * label keys in alphabetical order (seriesKey sorts them before JSON.stringify), so
 * "client=...,outcome=..." is a stable substring regardless of call-site argument order.
 */
function parseDurationSeries(
  rendered: string,
  metricName: string,
  clientName: string,
  outcome: string,
): { sum: number; count: number } | undefined {
  const label = `client="${clientName}",outcome="${outcome}"`;
  const sumRe = new RegExp(`${metricName}_sum\\{${label}\\}\\s+([0-9.eE+-]+)`);
  const countRe = new RegExp(`${metricName}_count\\{${label}\\}\\s+([0-9.eE+-]+)`);
  const sumMatch = rendered.match(sumRe);
  const countMatch = rendered.match(countRe);
  if (!sumMatch || !countMatch) return undefined;
  return { sum: Number(sumMatch[1]), count: Number(countMatch[1]) };
}

/** Sums every series' value for a Counter whose render() label exactly matches labelStr. */
function parseCounterForLabel(rendered: string, metricName: string, labelStr: string): number {
  const re = new RegExp(`${metricName}\\{${labelStr}\\}\\s+(\\d+)`, "g");
  let total = 0;
  for (const m of rendered.matchAll(re)) {
    total += Number(m[1]);
  }
  return total;
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  refreshLeaderStatus(); // health.ts's loop only probes backends when isLeader() is true
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Cluster hc3a — the non-ok-response failure path (lines 56-58)
// ---------------------------------------------------------------------------

describe("checkBatch — non-ok HTTP response records failure metrics with correct labels/duration", () => {
  // Kills 39 (ObjectLiteral {client,outcome:"failure"} -> {}), 40 (StringLiteral
  // "failure" -> ""), 41 (ArithmeticOperator / -> *), 42 (ArithmeticOperator - -> +),
  // 43 (ObjectLiteral {outcome:"failure"} -> {}), 44 (StringLiteral "failure" -> "").
  test('a 503 response observes duration under {client,outcome:"failure"} and increments the failure counter', async () => {
    const name = "hc3-nonok-fail";
    await registerClient(name);

    const runsBefore = parseCounterForLabel(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      `outcome="failure"`,
    );

    // Artificial delay so the elapsed time fed into the duration formula is
    // large enough (~30ms) to clearly distinguish division-by-1000 (correct,
    // yields ~0.03) from multiplication-by-1000 (mutant, yields ~30) or from
    // the inner "+" mutant (yields a huge ~2*Date.now()/1000, in the billions).
    globalThis.fetch = (async () => {
      await delay(30);
      return new Response("service unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const stop = startHealthCheckLoop();
    try {
      await delay(150);
    } finally {
      stop();
    }

    const series = parseDurationSeries(
      healthCheckDuration.render(),
      "mcp_health_check_duration_seconds",
      name,
      "failure",
    );
    expect(series).toBeDefined();
    expect(series?.count).toBe(1);
    // Correct value is elapsed-ms/1000, i.e. a fraction of a second. Both the
    // "* 1000" and the "Date.now() + hcStart" mutants blow this far past any
    // sane health-check duration.
    expect(series?.sum ?? -1).toBeGreaterThan(0);
    expect(series?.sum ?? Infinity).toBeLessThan(2);

    const runsAfter = parseCounterForLabel(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      `outcome="failure"`,
    );
    expect(runsAfter).toBeGreaterThan(runsBefore);
  });
});

// ---------------------------------------------------------------------------
// Cluster hc3b — the catch block wrapping the whole per-client check (lines 60-68)
// ---------------------------------------------------------------------------

describe("checkBatch — a thrown fetch error logs, records failure metrics, and evicts via handleFailure", () => {
  // Kills 45 (BlockStatement -> {}, the entire catch body wiped), 46 (ObjectLiteral
  // {client,outcome:"failure"} -> {}), 47 (StringLiteral "failure" -> ""),
  // 48 (ArithmeticOperator / -> *), 49 (ArithmeticOperator - -> +), 50 (ObjectLiteral
  // {outcome:"failure"} -> {}), 51 (StringLiteral "failure" -> ""), 52 (StringLiteral
  // "warn" -> ""), 53 (StringLiteral "Health check failed" -> ""), 54 (ObjectLiteral
  // {client,error} -> {}).
  test("a thrown fetch error logs the exact warn message/meta, records duration+counter, and marks the client unreachable", async () => {
    const name = "hc3-catch-fail";
    await registerClient(name);

    const runsBefore = parseCounterForLabel(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      `outcome="failure"`,
    );

    globalThis.fetch = (async () => {
      await delay(30);
      throw new Error("boom-hc3");
    }) as unknown as typeof fetch;

    const logSpy = spyOn(loggerMod, "log");
    try {
      const stop = startHealthCheckLoop();
      try {
        await delay(150);
      } finally {
        stop();
      }

      // If the catch block were wiped (mutant 45), this call would simply never
      // happen. The exact literal args pin down the level/message (52, 53) and
      // the meta object (54, which also folds in the error-message computation).
      expect(logSpy).toHaveBeenCalledWith("warn", "Health check failed", {
        client: name,
        error: "boom-hc3",
      });
    } finally {
      logSpy.mockRestore();
    }

    const series = parseDurationSeries(
      healthCheckDuration.render(),
      "mcp_health_check_duration_seconds",
      name,
      "failure",
    );
    expect(series).toBeDefined();
    expect(series?.count).toBe(1);
    expect(series?.sum ?? -1).toBeGreaterThan(0);
    expect(series?.sum ?? Infinity).toBeLessThan(2);

    const runsAfter = parseCounterForLabel(
      healthCheckRunsTotal.render(),
      "mcp_health_check_runs_total",
      `outcome="failure"`,
    );
    expect(runsAfter).toBeGreaterThan(runsBefore);

    // handleFailure(client.name, previousStatus) ran (default maxConsecutiveFailures
    // is 3, so a single failure marks unreachable rather than evicting outright).
    const client = registry.getClient(name);
    expect(client?.status).toBe("unreachable");
  });

  // Kills 45 again from a second, independent angle: even with the counter/log
  // assertions above satisfied by coincidence, if the catch block's call to
  // handleFailure were removed, consecutive-failure tracking would never
  // advance and the client would never actually cross maxConsecutiveFailures
  // and get evicted, no matter how many ticks ran.
  test("repeated thrown fetch errors accumulate consecutive failures until eviction", async () => {
    const name = "hc3-catch-evict";
    const origThreshold = config.maxConsecutiveFailures;
    const origIntervalMs = config.healthCheckIntervalMs;
    (config as Record<string, unknown>).maxConsecutiveFailures = 3;
    (config as Record<string, unknown>).healthCheckIntervalMs = 20;

    try {
      await registerClient(name);

      globalThis.fetch = (async () => {
        throw new Error("boom-hc3-evict");
      }) as unknown as typeof fetch;

      const stop = startHealthCheckLoop();
      try {
        // ~20ms interval, so 150ms gives ~7 ticks — comfortably past the
        // 3-failure threshold if (and only if) handleFailure runs every tick.
        await delay(150);
      } finally {
        stop();
      }

      expect(registry.getClient(name)).toBeUndefined();
    } finally {
      (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;
      (config as Record<string, unknown>).healthCheckIntervalMs = origIntervalMs;
    }
  });
});
