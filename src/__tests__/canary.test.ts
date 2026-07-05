/**
 * Canary / failover secondary-upstream routing — the decision helper, setCanary
 * validation + IP pinning, and proxy integration (canary %, failover on open).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { getCanary, setCanary, decideSecondary, type CanaryConfig } from "../tool-policies/canary.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
function makeTool(): RestToolDefinition {
  return {
    name: "get-x",
    method: "GET",
    endpoint: "/x",
    description: "x",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(): Promise<void> {
  await registry.register(CLIENT, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const cfg = (enabled: boolean, mode: "canary" | "failover", weight: number): CanaryConfig => ({
  secondaryBaseUrl: "http://5.6.7.8",
  secondaryResolvedIp: "5.6.7.8",
  mode,
  weight,
  enabled,
});

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});

describe("decideSecondary", () => {
  test("disabled config -> primary", () => {
    expect(decideSecondary(null, false)).toEqual({ useSecondary: false, bypassBreaker: false });
    expect(decideSecondary(cfg(false, "canary", 100), false)).toEqual({ useSecondary: false, bypassBreaker: false });
  });
  test("canary weight routes by probability", () => {
    expect(decideSecondary(cfg(true, "canary", 100), false, () => 0.5).useSecondary).toBe(true);
    expect(decideSecondary(cfg(true, "canary", 10), false, () => 0.5).useSecondary).toBe(false);
  });
  test("failover routes to secondary only when the breaker is open, bypassing it", () => {
    expect(decideSecondary(cfg(true, "failover", 50), false)).toEqual({ useSecondary: false, bypassBreaker: false });
    expect(decideSecondary(cfg(true, "failover", 50), true)).toEqual({ useSecondary: true, bypassBreaker: true });
  });
  test("canary mode does NOT failover when the breaker is open", () => {
    expect(decideSecondary(cfg(true, "canary", 100), true).useSecondary).toBe(false);
  });
});

describe("setCanary validation", () => {
  test("rejects unknown client / bad weight / bad url; accepts a valid raw-IP secondary", async () => {
    await reg();
    expect(
      await setCanary("ghost", { secondaryBaseUrl: "http://5.6.7.8", mode: "canary", weight: 50, enabled: true }),
    ).toMatchObject({ ok: false, error: "CLIENT_NOT_FOUND" });
    expect(
      await setCanary(CLIENT, { secondaryBaseUrl: "http://5.6.7.8", mode: "canary", weight: 0, enabled: true }),
    ).toMatchObject({ ok: false, error: "INVALID_WEIGHT" });
    expect(
      await setCanary(CLIENT, { secondaryBaseUrl: "not a url", mode: "canary", weight: 50, enabled: true }),
    ).toMatchObject({ ok: false, error: "INVALID_URL" });
    expect(
      await setCanary(CLIENT, { secondaryBaseUrl: "http://5.6.7.8", mode: "canary", weight: 50, enabled: true }),
    ).toEqual({ ok: true });
    expect(getCanary(CLIENT)?.secondaryResolvedIp).toBe("5.6.7.8");
  });

  test("clearing removes the config", async () => {
    await reg();
    await setCanary(CLIENT, { secondaryBaseUrl: "http://5.6.7.8", mode: "canary", weight: 50, enabled: true });
    await setCanary(CLIENT, null);
    expect(getCanary(CLIENT)).toBeNull();
  });
});

describe("proxy integration", () => {
  test("canary at 100% routes to the secondary backend", async () => {
    await reg();
    await setCanary(CLIENT, { secondaryBaseUrl: "http://5.6.7.8", mode: "canary", weight: 100, enabled: true });
    let lastUrl = "";
    globalThis.fetch = (async (url: string) => {
      lastUrl = String(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(r.isError).toBeUndefined();
    expect(lastUrl).toContain("5.6.7.8");
  });

  test("failover routes to the secondary once the primary breaker opens", async () => {
    await reg();
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });
    await setCanary(CLIENT, { secondaryBaseUrl: "http://5.6.7.8", mode: "failover", weight: 100, enabled: true });

    globalThis.fetch = (async (url: string) =>
      String(url).includes("1.2.3.4")
        ? new Response("down", { status: 500 })
        : new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch;

    // First call hits the (failing) primary and trips the breaker.
    const first = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(first.isError).toBe(true);

    // Second call: breaker is open -> failover to the healthy secondary.
    let secondUrl = "";
    globalThis.fetch = (async (url: string) => {
      secondUrl = String(url);
      return String(url).includes("1.2.3.4")
        ? new Response("down", { status: 500 })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const second = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(second.isError).toBeUndefined();
    expect(secondUrl).toContain("5.6.7.8");
  });

  test("no canary configured -> open breaker still fails fast", async () => {
    await reg();
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, {});
    const second = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/circuit breaker open/i);
  });
});
