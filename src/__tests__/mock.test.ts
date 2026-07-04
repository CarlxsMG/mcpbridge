/**
 * Mock / virtualization — config persistence and proxy integration: an "always"
 * mock short-circuits the upstream; a "fallback" mock is returned on backend
 * unavailability (network error / 5xx) but NOT on a 4xx client error.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { getToolMock, setToolMock } from "../mock.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
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

describe("config persistence", () => {
  test("unknown tool -> false; set/get; clear", async () => {
    await reg();
    expect(setToolMock(CLIENT, "nope", { enabled: true, mode: "always", response: "{}" })).toBe(false);
    expect(setToolMock(CLIENT, "get-x", { enabled: true, mode: "fallback", response: '{"ok":1}' })).toBe(true);
    expect(getToolMock(CLIENT, "get-x")).toEqual({ enabled: true, mode: "fallback", response: '{"ok":1}' });
    expect(setToolMock(CLIENT, "get-x", null)).toBe(true);
    expect(getToolMock(CLIENT, "get-x")).toBeNull();
  });
});

describe("proxy integration", () => {
  test("'always' short-circuits the upstream", async () => {
    await reg();
    setToolMock(CLIENT, "get-x", { enabled: true, mode: "always", response: '{"mocked":true}' });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(fetched).toBe(false);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('{"mocked":true}');
  });

  test("'fallback' returns the mock on a network error", async () => {
    await reg();
    setToolMock(CLIENT, "get-x", { enabled: true, mode: "fallback", response: "FB" });
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("FB");
  });

  test("'fallback' returns the mock on a 5xx", async () => {
    await reg();
    setToolMock(CLIENT, "get-x", { enabled: true, mode: "fallback", response: "FB" });
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("FB");
  });

  test("'fallback' does NOT mask a 4xx client error", async () => {
    await reg();
    setToolMock(CLIENT, "get-x", { enabled: true, mode: "fallback", response: "FB" });
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("404");
  });
});
