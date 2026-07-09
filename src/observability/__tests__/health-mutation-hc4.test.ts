/**
 * Stryker mutation backstop — cluster hc4
 * src/observability/health.ts lines 74-126:
 *   - handleFailure() in full (registry.incrementConsecutiveFailures, the
 *     "already removed" early-return on failures===0, the eviction-escalation
 *     branch vs the "still under threshold" branch)
 *   - startHealthCheckLoop() in full (the leader-gated interval wrapper: the
 *     inner check() closure, its own try/catch around checkBatch +
 *     healthLoopErrorsTotal + log, and the startLeaderGatedInterval wiring)
 *
 * checkBatch/handleFailure are module-private — every test drives them
 * indirectly through the single exported entry point, startHealthCheckLoop().
 *
 * Baseline: reports/mutation/result.json, re-queried directly for this run.
 * 23 surviving (Survived) mutants with location.start.line in [74,126]:
 *   57, 59, 60, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
 *   80, 81, 86, 87, 88
 * Every one of the 23 is targeted below (no equivalents found in this range).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { refreshLeaderStatus } from "../../db/leader-lease.js";
import * as loggerMod from "../../logger.js";
import * as mcpServerMod from "../../mcp/mcp-server.js";
import { healthEvictionsTotal } from "../../observability/metrics.js";
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

/** Sum of counter values for series whose labels include `${label}="${value}"`. */
function parseLabeledCounterTotal(rendered: string, metricName: string, label: string, value: string): number {
  const re = new RegExp(`${metricName}\\{[^}]*${label}="${value}"[^}]*\\}\\s+(\\d+(?:\\.\\d+)?)`, "g");
  let total = 0;
  for (const m of rendered.matchAll(re)) {
    total += Number(m[1]);
  }
  return total;
}

const originalFetch = globalThis.fetch;
const origThreshold = config.maxConsecutiveFailures;

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  refreshLeaderStatus(); // health.ts's loop only probes backends when isLeader() is true
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;
});

// ---------------------------------------------------------------------------
// handleFailure — "already removed" early return (lines 74-80)
// Kills: 57 (ConditionalExpression `failures === 0` -> false)
//        59 (BlockStatement `{ return; }` -> {})
// ---------------------------------------------------------------------------

describe("handleFailure — already-removed client returns early", () => {
  test("a client removed from the registry mid-check causes no status/notify/log side effects", async () => {
    const name = "hc4-removed-during-check";
    await registerClient(name);

    // Remove the client from inside the fetch call itself, so that by the
    // time handleFailure() runs, registry.incrementConsecutiveFailures(name)
    // returns 0 (client no longer exists) — the exact "already removed" case
    // documented at lines 76-77.
    globalThis.fetch = (async () => {
      await registry.unregister(name);
      return new Response("fail", { status: 500 });
    }) as unknown as typeof fetch;

    const notifySpy = spyOnNotify();
    const logSpy = spyOnLog();
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      // Real code: failures === 0 -> return immediately. Neither the
      // eviction branch nor the "still under threshold" branch ever runs.
      // Note: our own `registry.unregister(name)` call above (used to force
      // the "already removed" state) itself triggers exactly one
      // notifyToolsChanged() via teardownLiveClient — that's expected and
      // NOT part of what we're testing. What distinguishes the real code
      // from mutants 57/59 is whether handleFailure adds a SECOND call: if
      // the early return is skipped, 0 >= maxConsecutiveFailures is false
      // (default threshold > 0), so it falls into the non-eviction else
      // branch (previousStatus was "healthy") and fires notifyToolsChanged
      // again, for a total of 2 calls instead of 1. log() is never reached
      // by either the real code or these two mutants (only the eviction
      // branch logs), so it stays a plain sanity check here.
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleFailure — below-threshold branch, previousStatus healthy (lines 82, 98-103)
// Kills: 60 (ConditionalExpression `failures >= max` -> true)
//        75 (BlockStatement else-block -> {})
//        76 (StringLiteral "unreachable" -> "" at line 99)
//        77 (ConditionalExpression line 100 -> true)
//        78 (ConditionalExpression line 100 -> false)
//        79 (EqualityOperator line 100 -> previousStatus === "unreachable")
// ---------------------------------------------------------------------------

describe("handleFailure — below threshold, still-healthy client", () => {
  test("a single failure below maxConsecutiveFailures marks unreachable, notifies, and does NOT evict", async () => {
    const name = "hc4-below-threshold";
    (config as Record<string, unknown>).maxConsecutiveFailures = 5;
    await registerClient(name);

    globalThis.fetch = (async () => new Response("fail", { status: 500 })) as unknown as typeof fetch;

    const notifySpy = spyOnNotify();
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      // Real code: 1 < 5, so the else branch runs: markClientStatus(...,
      // "unreachable") + notifyToolsChanged() (previousStatus was "healthy"),
      // and the client is NOT unregistered.
      const client = registry.getClient(name);
      expect(client).toBeDefined();
      expect(client?.status).toBe("unreachable");
      expect(notifySpy).toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleFailure — below-threshold branch, previousStatus already unreachable (lines 98-103)
// Kills: 80 (StringLiteral "unreachable" -> "" inside the line-100 comparison)
//        81 (BlockStatement `{ notifyToolsChanged(); }` -> {} at line 100-102)
// (also reconfirms 76, 77, 78, 79 from a second angle)
// ---------------------------------------------------------------------------

describe("handleFailure — below threshold, already-unreachable client", () => {
  test("a repeat failure below threshold on an already-unreachable client re-marks unreachable but does NOT re-notify", async () => {
    const name = "hc4-below-threshold-already-unreachable";
    (config as Record<string, unknown>).maxConsecutiveFailures = 10;
    await registerClient(name);
    registry.markClientStatus(name, "unreachable"); // previousStatus for the upcoming tick

    globalThis.fetch = (async () => new Response("fail", { status: 500 })) as unknown as typeof fetch;

    const notifySpy = spyOnNotify();
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      const client = registry.getClient(name);
      expect(client).toBeDefined();
      expect(client?.status).toBe("unreachable");
      // previousStatus was already "unreachable" -> the `!== "unreachable"`
      // guard must suppress the notify call.
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleFailure — eviction branch, previousStatus healthy (lines 82-97)
// Kills: 65 (StringLiteral "unreachable" -> "" at line 84)
//        66 (ConditionalExpression line 85 -> true)
//        67 (ConditionalExpression line 85 -> false)
//        68 (EqualityOperator line 85 -> previousStatus === "unreachable")
//        69 (StringLiteral "unreachable" -> "" inside line-85 comparison)
//        70 (BlockStatement line 85-87 -> {})
//        71 (StringLiteral "warn" -> "" at line 89)
//        72 (StringLiteral template message -> `` at line 89)
//        73 (ObjectLiteral `{ client: name }` -> {} at line 89-91)
//        74 (ObjectLiteral `{ client: name }` -> {} at line 93, healthEvictionsTotal.inc arg)
// ---------------------------------------------------------------------------

describe("handleFailure — eviction, previously-healthy client", () => {
  test("crossing the threshold marks unreachable, notifies, logs the exact eviction message, increments the labeled counter, and unregisters", async () => {
    const name = "hc4-evict-healthy";
    (config as Record<string, unknown>).maxConsecutiveFailures = 1;
    await registerClient(name);

    globalThis.fetch = (async () => new Response("fail", { status: 500 })) as unknown as typeof fetch;

    const notifySpy = spyOnNotify();
    const logSpy = spyOnLog();
    const markStatusSpy = spyOnMarkStatus();
    const countBefore = parseLabeledCounterTotal(
      healthEvictionsTotal.render(),
      "mcp_health_evictions_total",
      "client",
      name,
    );
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      // Marked unreachable first (line 84), with the exact string literal.
      expect(markStatusSpy).toHaveBeenCalledWith(name, "unreachable");
      // previousStatus was "healthy" -> the explicit notify at line 85-87
      // fires once, AND registry.unregister()'s own teardownLiveClient()
      // unconditionally fires a second one — so real code produces exactly
      // 2 calls. Mutants that skip/invert the explicit call (67 cond->false,
      // 68 equality flip, 70 block->{}) would drop this to 1 (only
      // unregister's own), which `toHaveBeenCalled()` alone would NOT catch
      // since unregister's call still satisfies "called at least once" —
      // the exact count is load-bearing here.
      expect(notifySpy).toHaveBeenCalledTimes(2);
      // Exact eviction log call (line 89-91): level, interpolated count, client object.
      expect(logSpy).toHaveBeenCalledWith("warn", `Auto-evicting client after 1 consecutive health failures`, {
        client: name,
      });
      // healthEvictionsTotal.inc({ client: name }) — labeled specifically, not just any series.
      const countAfter = parseLabeledCounterTotal(
        healthEvictionsTotal.render(),
        "mcp_health_evictions_total",
        "client",
        name,
      );
      expect(countAfter).toBe(countBefore + 1);
      // Client actually evicted.
      expect(registry.getClient(name)).toBeUndefined();
    } finally {
      notifySpy.mockRestore();
      logSpy.mockRestore();
      markStatusSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// handleFailure — eviction branch, previousStatus already unreachable (lines 84-87)
// Kills: 66 (ConditionalExpression line 85 -> true) from the other angle
//        69 (StringLiteral "unreachable" -> "" inside line-85 comparison) from the other angle
// ---------------------------------------------------------------------------

describe("handleFailure — eviction, already-unreachable client", () => {
  test("crossing the threshold on an already-unreachable client evicts but does NOT re-notify", async () => {
    const name = "hc4-evict-already-unreachable";
    (config as Record<string, unknown>).maxConsecutiveFailures = 1;
    await registerClient(name);
    registry.markClientStatus(name, "unreachable"); // previousStatus for the upcoming tick

    globalThis.fetch = (async () => new Response("fail", { status: 500 })) as unknown as typeof fetch;

    const notifySpy = spyOnNotify();
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      // previousStatus was already "unreachable" -> the explicit notify at
      // line 85-87 must be suppressed, but registry.unregister() still
      // unconditionally fires one via teardownLiveClient() — so real code
      // produces exactly 1 call, not 0. Mutants that force the explicit call
      // anyway (66 cond->true, 69 string->"" widening the comparison) would
      // push this to 2 — the exact count is load-bearing here (a bare
      // `not.toHaveBeenCalled()` would be wrong even for real code, since
      // unregister's own call always fires).
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(registry.getClient(name)).toBeUndefined();
    } finally {
      notifySpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// startHealthCheckLoop — outer catch around checkBatch (lines 113-122)
// Kills: 86 (StringLiteral "error" -> "" at line 119)
//        87 (StringLiteral message -> "" at line 119)
//        88 (ObjectLiteral `{ error: ... }` -> {} at line 119-121)
// ---------------------------------------------------------------------------

describe("startHealthCheckLoop — outer catch logs the exact error message", () => {
  test("an exception thrown directly by registry.listClients() is caught and logged verbatim", async () => {
    await registerClient("hc4-outer-catch-placeholder");

    const origListClients = registry.listClients.bind(registry);
    (registry as { listClients: () => readonly { name: string }[] }).listClients = function () {
      throw new Error("hc4 simulated listClients failure");
    };

    const logSpy = spyOnLog();
    try {
      const { startHealthCheckLoop } = await import("../../observability/health.js");
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();

      expect(logSpy).toHaveBeenCalledWith("error", "Health check loop encountered an unhandled error", {
        error: "hc4 simulated listClients failure",
      });
    } finally {
      (registry as { listClients: () => readonly { name: string }[] }).listClients = origListClients;
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Spy helpers (declared after use above via function hoisting)
// ---------------------------------------------------------------------------

function spyOnNotify() {
  return spyOn(mcpServerMod, "notifyToolsChanged");
}

function spyOnLog() {
  return spyOn(loggerMod, "log");
}

function spyOnMarkStatus() {
  return spyOn(registry, "markClientStatus");
}
