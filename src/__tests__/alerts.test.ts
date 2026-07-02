/**
 * Alert rule CRUD + periodic evaluation (edge-triggered webhook dispatch).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { registry } from "../registry.js";
import {
  createAlertRule,
  listAlertRules,
  updateAlertRule,
  deleteAlertRule,
  evaluateAlerts,
  __resetAlertStateForTesting,
} from "../alerts.js";
import type { RestToolDefinition } from "../types.js";

const originalFetch = globalThis.fetch;
const originalAllowPrivate = config.allowPrivateIps;

function makeTool(): RestToolDefinition {
  return { name: "get-users", method: "GET", endpoint: "/users", description: "list", inputSchema: { type: "object", properties: {} } };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

let fetchCalls = 0;
function mockFetch(): void {
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; return new Response("ok", { status: 200 }); }) as unknown as typeof fetch;
}

beforeEach(async () => {
  __resetDbForTesting();
  __resetAlertStateForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("alert rule CRUD", () => {
  test("create / list / update / delete", () => {
    const r = createAlertRule({ name: "cb", eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/x", threshold: null, minCalls: null, actor: "t" });
    expect(listAlertRules()).toHaveLength(1);
    expect(updateAlertRule(r.id, { enabled: false })?.enabled).toBe(false);
    expect(deleteAlertRule(r.id)).toBe(true);
    expect(listAlertRules()).toHaveLength(0);
  });
});

describe("alert evaluation", () => {
  test("fires a webhook when a client becomes unreachable, edge-triggered", async () => {
    await reg("svc");
    registry.markClientStatus("svc", "unreachable");
    createAlertRule({ name: "down", eventType: "client_unreachable", webhookUrl: "http://127.0.0.1:9/hook", threshold: null, minCalls: null, actor: null });
    mockFetch();

    await evaluateAlerts();
    expect(fetchCalls).toBe(1);

    // Still unreachable — must NOT fire again (edge-triggered).
    await evaluateAlerts();
    expect(fetchCalls).toBe(1);

    // Recovers, then fails again — fires once more.
    registry.markClientStatus("svc", "healthy");
    await evaluateAlerts();
    registry.markClientStatus("svc", "unreachable");
    await evaluateAlerts();
    expect(fetchCalls).toBe(2);
  });

  test("does not fire for a healthy system", async () => {
    await reg("svc");
    createAlertRule({ name: "down", eventType: "client_unreachable", webhookUrl: "http://127.0.0.1:9/hook", threshold: null, minCalls: null, actor: null });
    mockFetch();
    await evaluateAlerts();
    expect(fetchCalls).toBe(0);
  });

  test("disabled rules are skipped", async () => {
    await reg("svc");
    registry.markClientStatus("svc", "unreachable");
    const r = createAlertRule({ name: "down", eventType: "client_unreachable", webhookUrl: "http://127.0.0.1:9/hook", threshold: null, minCalls: null, actor: null });
    updateAlertRule(r.id, { enabled: false });
    mockFetch();
    await evaluateAlerts();
    expect(fetchCalls).toBe(0);
  });

  test("fires a webhook on schema drift, edge-triggered, and stops once cleared", async () => {
    await reg("svc");
    getDb()
      .query(
        `INSERT INTO tool_monitor (client_name, tool_name, example_id, baseline_schema_hash, drift_detected, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("svc", "get-users", 1, "deadbeef", 1, Date.now());
    createAlertRule({ name: "drift", eventType: "schema_drift", webhookUrl: "http://127.0.0.1:9/hook", threshold: null, minCalls: null, actor: null });
    mockFetch();

    await evaluateAlerts();
    expect(fetchCalls).toBe(1);

    // Still drifted — must NOT fire again (edge-triggered).
    await evaluateAlerts();
    expect(fetchCalls).toBe(1);

    // Cleared, then drifts again — fires once more.
    getDb().query(`UPDATE tool_monitor SET drift_detected = 0 WHERE client_name = ? AND tool_name = ?`).run("svc", "get-users");
    await evaluateAlerts();
    getDb().query(`UPDATE tool_monitor SET drift_detected = 1 WHERE client_name = ? AND tool_name = ?`).run("svc", "get-users");
    await evaluateAlerts();
    expect(fetchCalls).toBe(2);
  });
});
