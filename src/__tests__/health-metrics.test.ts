/**
 * TEST 9 — Health metrics counters fire
 *
 * Verifies that:
 *   1. healthLoopErrorsTotal increments when the health loop's inner body throws.
 *   2. healthEvictionsTotal increments when a client is evicted after threshold failures.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../registry.js";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { refreshLeaderStatus } from "../db/leader-lease.js";
import type { RestToolDefinition } from "../types.js";

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

/** Parse the current total count from a Counter's render() output. */
function parseCounterTotal(rendered: string, metricName: string): number {
  const re = new RegExp(`${metricName}\\S*\\s+(\\d+)`, "g");
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
// TEST 9a: healthLoopErrorsTotal increments when checkBatch throws
// ---------------------------------------------------------------------------

describe("health metrics — healthLoopErrorsTotal increments on loop body error", () => {
  test("healthLoopErrorsTotal increments after the loop body throws once", async () => {
    const { healthLoopErrorsTotal } = await import("../observability/metrics.js");

    // Register a client so checkBatch is called with a non-empty list
    await registerClient("loop-error-svc");

    const countBefore = parseCounterTotal(healthLoopErrorsTotal.render(), "mcp_health_loop_errors_total");

    // Make fetch throw so checkBatch itself throws (unhandled path)
    // The outer try/catch in startHealthCheckLoop catches this and increments healthLoopErrorsTotal.
    // We force the error by making the health URL's fetch throw an unexpected non-Error object
    // that propagates past the inner catch in checkBatch.
    //
    // Actually checkBatch catches fetch errors internally per-client. To make the OUTER catch fire
    // we need listClients() or checkBatch itself to throw. We patch registry.listClients temporarily.
    const origListClients = registry.listClients.bind(registry);
    (registry as { listClients: () => readonly { name: string }[] }).listClients = function () {
      throw new Error("simulated listClients failure");
    };

    try {
      const { startHealthCheckLoop } = await import("../health.js");
      const stop = startHealthCheckLoop();
      // Give the immediate check time to run
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
    } finally {
      (registry as { listClients: () => readonly { name: string }[] }).listClients = origListClients;
    }

    const countAfter = parseCounterTotal(healthLoopErrorsTotal.render(), "mcp_health_loop_errors_total");

    // If healthLoopErrorsTotal.inc({}) were removed, countAfter would equal countBefore.
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// ---------------------------------------------------------------------------
// TEST 9b: healthEvictionsTotal increments on client eviction
// ---------------------------------------------------------------------------

describe("health metrics — healthEvictionsTotal increments on eviction", () => {
  test("healthEvictionsTotal increments after a client fails past maxConsecutiveFailures", async () => {
    const { healthEvictionsTotal } = await import("../observability/metrics.js");

    const countBefore = parseCounterTotal(healthEvictionsTotal.render(), "mcp_health_evictions_total");

    // Set threshold to 1 so a single failure triggers eviction
    const origThreshold = config.maxConsecutiveFailures;
    (config as Record<string, unknown>).maxConsecutiveFailures = 1;

    await registerClient("evict-metrics-svc");

    // Mock fetch to always return 500 → health check fails
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();

    (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;

    const countAfter = parseCounterTotal(healthEvictionsTotal.render(), "mcp_health_evictions_total");

    // If healthEvictionsTotal.inc({ client: name }) were removed, countAfter would equal countBefore.
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
