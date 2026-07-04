/**
 * Traffic capture — direct record/list/get/prune, plus proxy integration
 * (opt-in capture records args + a result preview for the explorer/replay).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { recordTraffic, listTraffic, getTraffic, pruneTraffic } from "../observability/traffic.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).trafficCaptureEnabled = false; // must not leak to other files
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

describe("record / list / get / prune", () => {
  test("stores full args + a result preview; list & get read it back", () => {
    recordTraffic({
      mcpToolName: "svc__get-x",
      clientName: "svc",
      toolName: "get-x",
      keyId: null,
      args: { a: 1 },
      result: { content: [{ type: "text", text: "hello" }] },
      durationMs: 5,
    });
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      mcpToolName: "svc__get-x",
      clientName: "svc",
      toolName: "get-x",
      preview: "hello",
      isError: false,
    });
    expect(JSON.parse(items[0].argsJson)).toEqual({ a: 1 });
    expect(getTraffic(items[0].id)?.preview).toBe("hello");
  });

  test("errorsOnly filter and prune", () => {
    recordTraffic({
      mcpToolName: "svc__a",
      clientName: "svc",
      toolName: "a",
      keyId: null,
      args: {},
      result: { content: [{ type: "text", text: "ok" }] },
      durationMs: 1,
    });
    recordTraffic({
      mcpToolName: "svc__b",
      clientName: "svc",
      toolName: "b",
      keyId: null,
      args: {},
      result: { content: [{ type: "text", text: "bad" }], isError: true },
      durationMs: 1,
    });
    expect(listTraffic({ errorsOnly: true }).items).toHaveLength(1);
    expect(listTraffic({ toolName: "a" }).items).toHaveLength(1);
    // Prune everything by moving the cutoff far into the future.
    expect(pruneTraffic(Date.now() + config.trafficRetentionMs + 1000)).toBe(2);
    expect(listTraffic({}).items).toHaveLength(0);
  });

  test("cursor pagination: id < cursor, ordered newest-first, nextCursor set only when more rows remain", () => {
    for (let i = 1; i <= 5; i++) {
      recordTraffic({
        mcpToolName: `svc__t${i}`,
        clientName: "svc",
        toolName: `t${i}`,
        keyId: null,
        args: {},
        result: { content: [{ type: "text", text: "ok" }] },
        durationMs: 1,
      });
    }
    const page1 = listTraffic({ limit: 2 });
    expect(page1.items.map((r) => r.toolName)).toEqual(["t5", "t4"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = listTraffic({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.toolName)).toEqual(["t3", "t2"]);
    expect(page2.nextCursor).toBeDefined();

    const page3 = listTraffic({ limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((r) => r.toolName)).toEqual(["t1"]);
    expect(page3.nextCursor).toBeUndefined();
  });
});

describe("proxy integration", () => {
  test("capture off by default: no rows", async () => {
    await reg();
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, { q: "hi" });
    expect(listTraffic({}).items).toHaveLength(0);
  });

  test("capture on: records args and a preview of the result", async () => {
    await reg();
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    globalThis.fetch = (async () =>
      new Response('{"r":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, { q: "hi" });
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    expect(items[0].mcpToolName).toBe(`${CLIENT}__get-x`);
    expect(JSON.parse(items[0].argsJson)).toEqual({ q: "hi" });
    expect(items[0].preview).toContain('"r": 1');
    expect(items[0].isError).toBe(false);
  });
});
