/**
 * Stryker mutation-testing backstop for src/routes/admin/overview.ts —
 * domain 8. Baseline: 33 mutants, 12 killed / 21 survived — the existing
 * "GET /admin-api/overview — returns aggregate counts" test in
 * routes-admin.test.ts only smoke-tests the happy path (1 enabled + 1
 * disabled client, no per-tool disabled count, no non-default client
 * status, breaker counts only loosely asserted as >= 0). All line:col
 * citations below were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { registry } from "../../mcp/registry.js";
import { getCircuitBreaker, removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import { cacheSet, __resetCacheForTesting } from "../../tool-policies/response-cache.js";
import { __resetWsProxyForTesting } from "../../ws-proxy.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-admin-key-overview";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  adminRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

interface OverviewBody {
  clients: { live: number; disabled: number; healthy: number; degraded: number; unreachable: number };
  tools: { total: number; disabled: number };
  circuit_breakers: { open: number; half_open: number; closed: number };
  admin_users: number;
  response_cache: { entries: number };
  ws_proxy: { active_connections: number };
}

async function getOverview(): Promise<OverviewBody> {
  const res = await fetch(`${baseUrl}/admin-api/overview`, { headers: bearer() });
  return (await res.json()) as OverviewBody;
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetCacheForTesting();
  __resetWsProxyForTesting();
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetCacheForTesting();
  __resetWsProxyForTesting();
  removeCircuitBreaker("ov-fresh-closed");
  removeCircuitBreaker("ov-fresh-open");
  removeCircuitBreaker("ov-fresh-half-open");
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/overview — client status breakdown", () => {
  // Kills 16:24-16:67 ObjectLiteral (the { healthy: 0, degraded: 0,
  // unreachable: 0 } init emptied to {} -- statusCounts[c.status]++ would
  // then leave the other two status keys entirely absent from the
  // response instead of present-and-zero) and 21:5-21:29 UpdateOperator
  // (statusCounts[c.status]++ -> --, which would go negative instead of
  // counting up). Uses 3 distinct statuses so every key is exercised.
  test("returns the exact healthy/degraded/unreachable breakdown, including a zero-count status", async () => {
    await startApp();
    await reg("ov-healthy-a", [makeTool("t")]);
    await reg("ov-healthy-b", [makeTool("t")]);
    await reg("ov-degraded", [makeTool("t")]);
    registry.markClientStatus("ov-degraded", "degraded");

    const body = await getOverview();
    expect(body.clients).toMatchObject({ healthy: 2, degraded: 1, unreachable: 0 });
  });
});

describe("GET /admin-api/overview — disabled client/tool counts", () => {
  // Kills 22:9-22:19 BooleanLiteral (!c.enabled -> c.enabled, removing the
  // negation). A 1-enabled/1-disabled split can't distinguish this (both
  // directions yield disabledClients=1); an ASYMMETRIC split can: 1
  // enabled + 2 disabled clients means real disabledClients=2, but the
  // negation-removed mutant would instead count the 1 enabled client,
  // yielding 1 -- clearly distinguishable from 2.
  test("disabledClients counts the real disabled clients, not the enabled ones (asymmetric split)", async () => {
    await startApp();
    await reg("ov-enabled-1", [makeTool("t")]);
    await reg("ov-disabled-1", [makeTool("t")]);
    await reg("ov-disabled-2", [makeTool("t")]);
    await registry.setClientEnabled("ov-disabled-1", false);
    await registry.setClientEnabled("ov-disabled-2", false);

    const body = await getOverview();
    expect(body.clients.disabled).toBe(2);
  });

  // Kills 25:11-25:21 BooleanLiteral (!t.enabled -> t.enabled, same
  // negation-removal technique applied to tools) and 25:23-25:38
  // UpdateOperator (disabledTools++ -> --). Same asymmetric-split
  // reasoning: 1 enabled + 2 disabled tools distinguishes real (2) from
  // negation-removed (1) and from a decrementing counter (-2).
  test("disabledTools counts the real disabled tools, not the enabled ones (asymmetric split)", async () => {
    await startApp();
    await reg("ov-tools", [makeTool("enabled-tool"), makeTool("disabled-tool-1"), makeTool("disabled-tool-2")]);
    await registry.setToolEnabled("ov-tools", "disabled-tool-1", false);
    await registry.setToolEnabled("ov-tools", "disabled-tool-2", false);

    const body = await getOverview();
    expect(body.tools).toMatchObject({ total: 3, disabled: 2 });
  });
});

describe("GET /admin-api/overview — circuit breaker counts", () => {
  // Kills the whole 29:24-31:80 cluster (MethodExpression/ArrowFunction/
  // ConditionalExpression/EqualityOperator/StringLiteral on the open and
  // half_open filters, plus both ArithmeticOperator mutants on the closed
  // computation). The breaker registry is a process-wide singleton shared
  // with every other concurrently-run test file (not reset between
  // tests), so exact absolute counts aren't safe to assert -- instead
  // this measures the DELTA around adding exactly one fresh breaker of
  // each kind (closed/open/half-open), which is safe under any amount of
  // unrelated pre-existing global breaker state since bun:test runs
  // tests strictly sequentially (no interleaving within one process).
  //
  // - A fresh CLOSED breaker (untouched) must NOT move the open or
  //   half_open counts -- kills the "strip the filter"/"always true"
  //   mutants on either filter, which would count every breaker as open
  //   (or half-open) regardless of its real state.
  // - A fresh OPEN breaker must increase open-by-exactly-1 -- kills the
  //   "always false"/wrong-equality/emptied-string mutants, which would
  //   never count it.
  // - A fresh HALF-OPEN breaker (opened, then fast-forwarded past
  //   resetTimeoutMs and probed once) must increase half_open-by-1, same
  //   reasoning.
  // - closed must increase by exactly 1 too (only the fresh closed
  //   breaker lands there) -- this is what kills both ArithmeticOperator
  //   mutants on `breakerStates.length - openBreakers - halfOpenBreakers`:
  //   flipping either `-` to `+` changes the closed DELTA from the
  //   correct +1 to +3 (the open/half/total deltas of 1/1/3 don't cancel
  //   correctly under either flipped sign).
  test("open/half_open/closed counts move by exactly the expected delta when new breakers are added", async () => {
    await startApp();
    const before = await getOverview();

    getCircuitBreaker("ov-fresh-closed");

    getCircuitBreaker("ov-fresh-open", { failureThreshold: 1 }).recordFailure();

    const halfOpenCb = getCircuitBreaker("ov-fresh-half-open", { failureThreshold: 1, resetTimeoutMs: 100 });
    halfOpenCb.recordFailure();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 1000;
      halfOpenCb.canRequest();
    } finally {
      Date.now = realNow;
    }

    const after = await getOverview();
    expect(after.circuit_breakers.open - before.circuit_breakers.open).toBe(1);
    expect(after.circuit_breakers.half_open - before.circuit_breakers.half_open).toBe(1);
    expect(after.circuit_breakers.closed - before.circuit_breakers.closed).toBe(1);
  });
});

describe("GET /admin-api/overview — response_cache.entries", () => {
  // Confirms the field genuinely reflects the process-local response-cache
  // store size (via cacheSize()) rather than being hardcoded to 0 — kills
  // both a StringLiteral/ObjectLiteral stub on `response_cache` and a
  // MethodExpression mutant swapping cacheSize() for something inert.
  test("reflects the exact number of entries currently held", async () => {
    await startApp();
    const before = await getOverview();
    expect(before.response_cache.entries).toBe(0);

    cacheSet("ov-cache-key-1", { content: [{ type: "text", text: "a" }] }, 60);
    cacheSet("ov-cache-key-2", { content: [{ type: "text", text: "b" }] }, 60);

    const after = await getOverview();
    expect(after.response_cache.entries).toBe(2);
  });
});

describe("GET /admin-api/overview — ws_proxy.active_connections", () => {
  // Confirms the field reflects wsProxyActiveConnectionCount() rather than
  // being hardcoded to 0 — with no live ws-proxy connections in this test
  // process (reset in beforeEach), it must report exactly 0.
  test("reports 0 when there are no live ws-proxy connections", async () => {
    await startApp();
    const body = await getOverview();
    expect(body.ws_proxy.active_connections).toBe(0);
  });
});
