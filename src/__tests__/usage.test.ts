/**
 * Usage analytics: store aggregations + proxy attribution.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { proxyToolCall } from "../proxy/proxy.js";
import {
  recordUsage,
  getUsageSummary,
  getUsageTimeseries,
  getTopTools,
  getUsageByKey,
} from "../observability/usage.js";
import { createMcpKey } from "../security/mcp-key-store.js";
import type { RestToolDefinition } from "../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("usage store aggregations", () => {
  test("summary counts calls, errors, and error rate", () => {
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "5xx", isError: true, durationMs: 20 });
    recordUsage({ clientName: "svc", toolName: "b", keyId: 1, statusClass: "2xx", isError: false, durationMs: 30 });
    const s = getUsageSummary();
    expect(s.calls).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBeCloseTo(1 / 3);
    expect(s.tools).toBe(2);
  });

  test("top tools ordered by call count", () => {
    for (let i = 0; i < 5; i++)
      recordUsage({
        clientName: "svc",
        toolName: "busy",
        keyId: null,
        statusClass: "2xx",
        isError: false,
        durationMs: 5,
      });
    recordUsage({
      clientName: "svc",
      toolName: "rare",
      keyId: null,
      statusClass: "2xx",
      isError: false,
      durationMs: 5,
    });
    const top = getTopTools({ limit: 10 });
    expect(top[0].tool).toBe("busy");
    expect(top[0].calls).toBe(5);
  });

  test("by-key groups and labels the unattributed bucket", () => {
    const { record } = createMcpKey("bot", null, null, null);
    recordUsage({
      clientName: "svc",
      toolName: "a",
      keyId: record.id,
      statusClass: "2xx",
      isError: false,
      durationMs: 5,
    });
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
    const byKey = getUsageByKey();
    expect(byKey.find((k) => k.keyId === record.id)?.label).toBe("bot");
    expect(byKey.find((k) => k.keyId === null)?.label).toBe("(unattributed)");
  });

  test("window filter excludes rows before `from`", () => {
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 5 });
    expect(getUsageSummary({ from: Date.now() + 60_000 }).calls).toBe(0);
  });
});

describe("usage timeseries", () => {
  test("buckets calls/errors and zero-fills across the window", () => {
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "2xx", isError: false, durationMs: 10 });
    recordUsage({ clientName: "svc", toolName: "a", keyId: null, statusClass: "5xx", isError: true, durationMs: 20 });
    const ts = getUsageTimeseries({ from: Date.now() - 60_000, bucketMs: 60_000 });
    expect(ts.bucketMs).toBe(60_000);
    expect(ts.points.reduce((sum, p) => sum + p.calls, 0)).toBe(2);
    expect(ts.points.reduce((sum, p) => sum + p.errors, 0)).toBe(1);
  });

  test("points are ascending and evenly spaced by bucketMs", () => {
    const ts = getUsageTimeseries({ from: Date.now() - 3 * 60_000, bucketMs: 60_000 });
    expect(ts.points.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ts.points.length; i++) {
      expect(ts.points[i].t - ts.points[i - 1].t).toBe(60_000);
    }
  });

  test("an empty window still zero-fills every bucket instead of returning gaps", () => {
    const ts = getUsageTimeseries({ from: Date.now() - 2 * 60_000, bucketMs: 60_000 });
    expect(ts.points.length).toBeGreaterThanOrEqual(2);
    expect(ts.points.every((p) => p.calls === 0 && p.errors === 0)).toBe(true);
  });
});

describe("proxy usage attribution", () => {
  test("a proxied success is recorded and attributed to the key", async () => {
    await reg("svc");
    const { rawKey, record } = createMcpKey("bot", null, null, null);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await proxyToolCall("svc__get-users", {}, rawKey);
    expect(res.isError).toBeUndefined();
    expect(getUsageSummary().calls).toBe(1);
    expect(getUsageByKey().find((k) => k.keyId === record.id)?.calls).toBe(1);
  });

  test("a proxied upstream error is recorded as an error", async () => {
    await reg("svc");
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const res = await proxyToolCall("svc__get-users", {});
    expect(res.isError).toBe(true);
    const s = getUsageSummary();
    expect(s.calls).toBe(1);
    expect(s.errors).toBe(1);
  });
});
