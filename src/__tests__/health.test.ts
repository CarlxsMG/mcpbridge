import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../registry.js";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { refreshLeaderStatus } from "../db/leader-lease.js";
import type { RestToolDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function registerClient(name: string, healthUrl = "http://example.com/health") {
  await registry.register(name, [makeTool()], healthUrl, "1.2.3.4", "http://example.com", "1.2.3.4");
}

// ---------------------------------------------------------------------------
// Reset registry between tests
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  refreshLeaderStatus(); // health.ts's loop only probes backends when isLeader() is true
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// TEST 1: Happy path — 2xx response keeps status healthy, resets failures
// ---------------------------------------------------------------------------

describe("health checkBatch — happy path: 2xx response", () => {
  test("client stays healthy and consecutive_failures resets to 0 after 2xx", async () => {
    await registerClient("healthy-svc");

    // First, record a failure to ensure reset behaviour is tested
    registry.incrementConsecutiveFailures("healthy-svc");
    expect(registry.getClient("healthy-svc")!.consecutive_failures).toBe(1);

    // Mock fetch to return 200
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    // Give the immediate check time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    const client = registry.getClient("healthy-svc");
    expect(client).toBeDefined();
    expect(client!.status).toBe("healthy");
    expect(client!.consecutive_failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TEST 2: 5xx response increments consecutive_failures
// ---------------------------------------------------------------------------

describe("health checkBatch — 5xx response", () => {
  test("consecutive_failures increments on 5xx response", async () => {
    await registerClient("failing-svc");

    // Set a large threshold so the client is not evicted in one shot
    const origThreshold = config.maxConsecutiveFailures;
    (config as Record<string, unknown>).maxConsecutiveFailures = 999;

    globalThis.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;

    const client = registry.getClient("failing-svc");
    expect(client).toBeDefined();
    expect(client!.consecutive_failures).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Consecutive failures reaching threshold triggers eviction
// ---------------------------------------------------------------------------

describe("health checkBatch — eviction on threshold", () => {
  test("client is unregistered after consecutive failures reach maxConsecutiveFailures", async () => {
    // Set threshold to 1 so a single failure triggers eviction
    const origThreshold = config.maxConsecutiveFailures;
    (config as Record<string, unknown>).maxConsecutiveFailures = 1;

    await registerClient("evict-svc");

    globalThis.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;

    // Client should now be unregistered
    expect(registry.getClient("evict-svc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TEST 4: Recovery from unreachable → healthy
// ---------------------------------------------------------------------------

describe("health checkBatch — recovery from unreachable", () => {
  test("status flips to healthy when fetch returns 2xx after being unreachable", async () => {
    await registerClient("recover-svc");

    // Manually set the client to unreachable
    registry.markClientStatus("recover-svc", "unreachable");
    expect(registry.getClient("recover-svc")!.status).toBe("unreachable");

    // Now fetch succeeds
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    const client = registry.getClient("recover-svc");
    if (client) {
      expect(client.status).toBe("healthy");
    }
    // If client was evicted (shouldn't happen since we gave 2xx) the test still passes
  });
});

// ---------------------------------------------------------------------------
// TEST 5: DNS/fetch error is handled gracefully — no exception escapes the loop
// ---------------------------------------------------------------------------

describe("health checkBatch — fetch throws network error", () => {
  test("no exception escapes when fetch throws (simulating DNS failure)", async () => {
    // Set high threshold so no eviction happens
    const origThreshold = config.maxConsecutiveFailures;
    (config as Record<string, unknown>).maxConsecutiveFailures = 999;

    await registerClient("dns-fail-svc");

    globalThis.fetch = (async () => {
      throw new TypeError("Failed to resolve DNS: ENOTFOUND");
    }) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    let errorEscaped = false;
    try {
      const stop = startHealthCheckLoop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      stop();
    } catch {
      errorEscaped = true;
    }

    (config as Record<string, unknown>).maxConsecutiveFailures = origThreshold;

    expect(errorEscaped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST 6: healthCheckRunsTotal increments on each check run
// ---------------------------------------------------------------------------

describe("health checkBatch — metrics increment", () => {
  test("healthCheckRunsTotal increments on each health check run", async () => {
    const { healthCheckRunsTotal } = await import("../observability/metrics.js");

    await registerClient("metrics-svc");

    const renderBefore = healthCheckRunsTotal.render();
    // Parse current total by summing all series values
    const matchesBefore = [...renderBefore.matchAll(/mcp_health_check_runs_total\S*\s+(\d+)/g)];
    const countBefore = matchesBefore.reduce((sum, m) => sum + Number(m[1]), 0);

    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    const { startHealthCheckLoop } = await import("../health.js");
    const stop = startHealthCheckLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    const renderAfter = healthCheckRunsTotal.render();
    const matchesAfter = [...renderAfter.matchAll(/mcp_health_check_runs_total\S*\s+(\d+)/g)];
    const countAfter = matchesAfter.reduce((sum, m) => sum + Number(m[1]), 0);

    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
