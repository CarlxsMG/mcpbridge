/**
 * Stryker mutation-testing backstop for src/routes/metrics.ts — domain 8.
 * Baseline: 60 mutants, 0 killed / 60 survived — zero test coverage of any
 * kind existed before this. All line:col citations below were read directly
 * from reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT, not chased with a dedicated test:
 * 30:37:39-54 OptionalChaining (`c.tools?.length` -> `c.tools.length`).
 * `RegisteredClient.tools` (src/mcp/types.ts) is a REQUIRED `RegisteredTool[]`
 * field, never optional, and every construction site in registry.ts always
 * assigns a real array — there is no reachable path where `c.tools` is
 * `undefined` on a value returned by `registry.listClients()`, so removing
 * the `?.` can never change behavior for any input reachable through this
 * codebase.
 */
import { describe, test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { getCircuitBreaker, removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { checkRateLimit, getRateLimitBucketSizes, _internalsForTesting } from "../../middleware/rate-limiter.js";
import { recordToolCall } from "../../observability/metrics.js";

const ADMIN_KEY = "test-admin-key-metrics-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).metricsEnabled = true;
  const { metricsRoutes } = await import("../../routes/metrics.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  metricsRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

async function reg(name: string, toolCount = 1): Promise<void> {
  await registry.register(
    name,
    Array.from({ length: toolCount }, (_, i) => ({
      name: `t${i}`,
      method: "GET",
      endpoint: `/t${i}`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
    })),
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

/** Extracts a gauge's current numeric value for an exact label substring, e.g. `tier="global"`. */
function gaugeValueFor(text: string, metricName: string, labelSubstring: string): number {
  const line = text.split("\n").find((l) => l.startsWith(metricName + "{") && l.includes(labelSubstring));
  if (!line) throw new Error(`no line found for ${metricName} with label ${labelSubstring}`);
  const value = line.slice(line.lastIndexOf(" ") + 1);
  return Number(value);
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /metrics", () => {
  // Kills 40 BooleanLiteral / 41-42 ConditionalExpression (the negated
  // `!config.metricsEnabled` guard) and 43 BlockStatement / 44-45
  // StringLiteral (the NOT_FOUND branch and its exact code/message).
  test("disabled via config returns the exact NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      (config as Record<string, unknown>).metricsEnabled = false;
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("Metrics endpoint is disabled");
    });
  });

  // Kills 37/38/39 (route path/handler body emptied), the complement of
  // 40-42 (must NOT 404 when enabled), and 46/47 StringLiteral (the exact
  // Content-Type header value).
  test("enabled renders Prometheus text with the exact content-type header", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      expect(res.status).toBe(200);
      // Bun's fetch/undici re-serializes Content-Type params in its own
      // order, so check substrings rather than exact string equality.
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("text/plain");
      expect(contentType).toContain("version=0.0.4");
      expect(contentType).toContain("charset=utf-8");
      const body = await res.text();
      expect(body).toContain("mcp_breaker_current_state");
    });
  });

  // Kills 1 BlockStatement (the breaker-gauge for-loop body emptied) and 2
  // ObjectLiteral (the `{ client }` label emptied) via a breaker forced into
  // a non-default (open, value 2) state.
  test("reports a tripped circuit breaker's gauge state", async () => {
    await withApp(async (baseUrl) => {
      const clientName = "metrics-test-breaker-client";
      getCircuitBreaker(clientName, { failureThreshold: 1 }).recordFailure();
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      const body = await res.text();
      expect(body).toContain(`mcp_breaker_current_state{client="${clientName}"} 2`);
    });
  });

  // Regression: the breaker gauge must be reset before each snapshot so an
  // evicted client's series doesn't linger at its last value (a permanent false
  // MCPCircuitBreakerOpen alert + unbounded cardinality). Without the reset the
  // second scrape would still show the stale `... 2` line.
  test("drops an evicted breaker's gauge series on the next scrape", async () => {
    await withApp(async (baseUrl) => {
      const clientName = "metrics-test-evicted-breaker";
      getCircuitBreaker(clientName, { failureThreshold: 1 }).recordFailure();
      const first = await (await fetch(`${baseUrl}/metrics`, { headers: bearer() })).text();
      expect(first).toContain(`mcp_breaker_current_state{client="${clientName}"}`);

      removeCircuitBreaker(clientName); // simulate idle eviction / unregister
      const second = await (await fetch(`${baseUrl}/metrics`, { headers: bearer() })).text();
      expect(second).not.toContain(`mcp_breaker_current_state{client="${clientName}"}`);
    });
  });

  // Kills 3-20 (the healthy/degraded/unreachable filter predicates' method/
  // arrow/conditional/equality/string mutants) and 21-26 (the three
  // `{status: "..."}` label object/string literals) -- one client per
  // status, so a wrongly-widened or emptied filter changes a DIFFERENT
  // label's count than the real, correctly-narrowed one.
  test("reports registry client counts distinctly per status", async () => {
    await withApp(async (baseUrl) => {
      await reg("metrics-test-status-healthy");
      await reg("metrics-test-status-degraded");
      await reg("metrics-test-status-unreachable");
      registry.markClientStatus("metrics-test-status-degraded", "degraded");
      registry.markClientStatus("metrics-test-status-unreachable", "unreachable");
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      const body = await res.text();
      expect(body).toContain('mcp_registry_clients{status="healthy"} 1');
      expect(body).toContain('mcp_registry_clients{status="degraded"} 1');
      expect(body).toContain('mcp_registry_clients{status="unreachable"} 1');
    });
  });

  // Kills 27 ArrowFunction (the reduce callback emptied), 28 ArithmeticOperator
  // (+ -> -), and 29 LogicalOperator (?? -> && -- which always evaluates to 0
  // regardless of tool count) via clients with DIFFERENT nonzero tool counts,
  // proving the exact summed total.
  test("computes registryToolsTotal as the exact sum across all clients", async () => {
    await withApp(async (baseUrl) => {
      await reg("metrics-test-tools-a", 2);
      await reg("metrics-test-tools-b", 3);
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      const body = await res.text();
      expect(body).toContain("mcp_registry_tools_total 5");
    });
  });

  // Kills 31-36 (the three `{tier: "..."}` label object/string literals for
  // global/mcp/register) plus the three tool/login/install_link tiers added in
  // finding #43. Uses real `checkRateLimit` insertions (via the test-only map
  // handles) with DIFFERENT counts per tier so a swapped or emptied tier label
  // is observable. Delta-based (not absolute) because these bucket maps are
  // process-wide, never-reset state shared with every other test file in a full
  // suite run.
  test("computes rateLimitBuckets per-tier from real bucket insertions", async () => {
    await withApp(async (baseUrl) => {
      const before = getRateLimitBucketSizes();
      checkRateLimit(_internalsForTesting.globalBuckets, 100_000, "metrics-test-rl-global-1", 1000, "global");
      checkRateLimit(_internalsForTesting.globalBuckets, 100_000, "metrics-test-rl-global-2", 1000, "global");
      checkRateLimit(_internalsForTesting.globalBuckets, 100_000, "metrics-test-rl-global-3", 1000, "global");
      checkRateLimit(_internalsForTesting.mcpBuckets, 100_000, "metrics-test-rl-mcp-1", 1000, "mcp");
      checkRateLimit(_internalsForTesting.mcpBuckets, 100_000, "metrics-test-rl-mcp-2", 1000, "mcp");
      checkRateLimit(_internalsForTesting.registerBuckets, 100_000, "metrics-test-rl-register-1", 1000, "register");
      checkRateLimit(_internalsForTesting.toolBuckets, 100_000, "metrics-test-rl-tool-1", 1000, "tool");
      checkRateLimit(_internalsForTesting.toolBuckets, 100_000, "metrics-test-rl-tool-2", 1000, "tool");
      checkRateLimit(_internalsForTesting.toolBuckets, 100_000, "metrics-test-rl-tool-3", 1000, "tool");
      checkRateLimit(_internalsForTesting.toolBuckets, 100_000, "metrics-test-rl-tool-4", 1000, "tool");
      checkRateLimit(_internalsForTesting.loginBuckets, 100_000, "metrics-test-rl-login-1", 1000, "login");
      checkRateLimit(_internalsForTesting.loginBuckets, 100_000, "metrics-test-rl-login-2", 1000, "login");
      checkRateLimit(_internalsForTesting.loginBuckets, 100_000, "metrics-test-rl-login-3", 1000, "login");
      checkRateLimit(_internalsForTesting.loginBuckets, 100_000, "metrics-test-rl-login-4", 1000, "login");
      checkRateLimit(_internalsForTesting.loginBuckets, 100_000, "metrics-test-rl-login-5", 1000, "login");
      checkRateLimit(_internalsForTesting.installLinkBuckets, 100_000, "metrics-test-rl-il-1", 1000, "install_link");
      const res = await fetch(`${baseUrl}/metrics`, { headers: bearer() });
      const body = await res.text();
      // Distinct delta per tier so a swapped/emptied tier label lands the wrong
      // count and fails: global+3, mcp+2, register+1, tool+4, login+5, install_link+1.
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="global"')).toBe(before.global + 3);
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="mcp"')).toBe(before.mcp + 2);
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="register"')).toBe(before.register + 1);
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="tool"')).toBe(before.tool + 4);
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="login"')).toBe(before.login + 5);
      expect(gaugeValueFor(body, "mcp_rate_limit_buckets", 'tier="install_link"')).toBe(before.install_link + 1);
    });
  });
});

describe("GET /metrics/legacy", () => {
  // Kills 48/49 (route path/handler body emptied) implicitly via a
  // successful hit, plus 56 (the whole res.json object emptied).
  test("returns the expected top-level shape", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/metrics/legacy`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty("uptime_seconds");
      expect(body).toHaveProperty("active_sessions");
      expect(body).toHaveProperty("registered_clients");
      expect(body).toHaveProperty("tool_calls");
      expect(body).toHaveProperty("circuit_breakers");
    });
  });

  // Kills 50-55 (the healthy-filter method/arrow/conditional/equality/string
  // mutants) and 57/58 (the registered_clients object emptied and the
  // `clients.length - healthy` arithmetic flipped to `+`). Needs an
  // ASYMMETRIC (2 healthy, 1 degraded) fixture, not a 1-vs-1 one: with one
  // client of each, the real `=== "healthy"` filter and the 54
  // `!== "healthy"` mutant both happen to count exactly 1 client (the
  // healthy one vs. the degraded one, respectively) -- coincidentally
  // identical, so that fixture doesn't kill the mutant. withApp's cleanup
  // fully unregisters clients between tests, so an exact (not delta)
  // assertion is valid here.
  test("registered_clients reports exact total/healthy/unreachable counts", async () => {
    await withApp(async (baseUrl) => {
      await reg("metrics-test-legacy-healthy-1");
      await reg("metrics-test-legacy-healthy-2");
      await reg("metrics-test-legacy-degraded");
      registry.markClientStatus("metrics-test-legacy-degraded", "degraded");
      const res = await fetch(`${baseUrl}/metrics/legacy`, { headers: bearer() });
      const body = (await res.json()) as {
        registered_clients: { total: number; healthy: number; unreachable: number };
      };
      expect(body.registered_clients).toEqual({ total: 3, healthy: 2, unreachable: 1 });
    });
  });

  // Kills 59 (the tool_calls object emptied). Delta-based because
  // `totalToolCalls`/`errorToolCalls` are process-wide counters that persist
  // for the whole test run (never reset between tests or files).
  test("tool_calls reflects real recordToolCall deltas", async () => {
    await withApp(async (baseUrl) => {
      const before = (await (await fetch(`${baseUrl}/metrics/legacy`, { headers: bearer() })).json()) as {
        tool_calls: { total: number; errors: number };
      };
      recordToolCall(120, false);
      recordToolCall(80, true);
      const after = (await (await fetch(`${baseUrl}/metrics/legacy`, { headers: bearer() })).json()) as {
        tool_calls: { total: number; errors: number };
      };
      expect(after.tool_calls.total - before.tool_calls.total).toBe(2);
      expect(after.tool_calls.errors - before.tool_calls.errors).toBe(1);
    });
  });
});
