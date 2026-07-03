import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { hashApiKey } from "../security/key-hash.js";
import { proxyToolCall } from "../proxy.js";
import type { RestToolDefinition } from "../types.js";

const CLIENT = "guarded-client";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-item",
    method: "GET",
    endpoint: "/item",
    description: "get an item",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const originalRetryBaseDelayMs = config.retryBaseDelayMs;
const originalRetryMaxAttempts = config.retryMaxAttempts;

beforeEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).retryMaxAttempts = 0; // guards are the thing under test, not retry backoff
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = originalRetryBaseDelayMs;
  (config as Record<string, unknown>).retryMaxAttempts = originalRetryMaxAttempts;
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});

function okFetch(): typeof fetch {
  return (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("proxyToolCall — per-tool rate limit guard", () => {
  test("no guard configured — unlimited calls succeed", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-item`, {});
    const r2 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBeUndefined();
  });

  test("guard rejects the call once the per-minute cap is exceeded, without reaching fetch", async () => {
    await reg();
    await registry.setToolGuards(CLIENT, "get-item", { rateLimitPerMin: 1 });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const first = await proxyToolCall(`${CLIENT}__get-item`, {});
    const second = await proxyToolCall(`${CLIENT}__get-item`, {});

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/rate limit/i);
    expect(fetchCalls).toBe(1);
  });
});

describe("proxyToolCall — per-tool timeout guard", () => {
  test("a short guard timeout aborts well before the global default", async () => {
    await reg();
    await registry.setToolGuards(CLIENT, "get-item", { timeoutMs: 50 });

    // Mock fetch that respects the AbortSignal like real fetch does, but would
    // otherwise resolve long after any reasonable test timeout.
    globalThis.fetch = ((_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => _resolve(new Response("{}", { status: 200 })), 5000);
        const signal = opts.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    // Well under the 5s mock resolution and the 30s global default — proves
    // the tool's 50ms guard timeout (not config.toolCallTimeoutMs) was used.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("proxyToolCall — allowed-key-hash guard", () => {
  test("no guard configured — call succeeds without any caller token", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const result = await proxyToolCall(`${CLIENT}__get-item`, {}, undefined);
    expect(result.isError).toBeUndefined();
  });

  test("guard allows a caller token whose hash matches, rejects one that doesn't", async () => {
    await reg();
    await registry.setToolGuards(CLIENT, "get-item", { allowedKeyHashes: [hashApiKey("good-token")] });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const allowed = await proxyToolCall(`${CLIENT}__get-item`, {}, "good-token");
    expect(allowed.isError).toBeUndefined();
    expect(fetchCalls).toBe(1);

    const rejected = await proxyToolCall(`${CLIENT}__get-item`, {}, "bad-token");
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toMatch(/not authorized/i);
    expect(fetchCalls).toBe(1); // unchanged — fetch was not called for the rejected attempt
  });

  test("guard fails closed when no caller token is supplied at all", async () => {
    await reg();
    await registry.setToolGuards(CLIENT, "get-item", { allowedKeyHashes: [hashApiKey("good-token")] });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(`${CLIENT}__get-item`, {}, undefined);
    expect(result.isError).toBe(true);
    expect(fetchCalled).toBe(false);
  });

  test("guard fails closed even when global auth is disabled", async () => {
    const originalAuthDisabled = config.authDisabled;
    (config as Record<string, unknown>).authDisabled = true;
    try {
      await reg();
      await registry.setToolGuards(CLIENT, "get-item", { allowedKeyHashes: [hashApiKey("good-token")] });

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const result = await proxyToolCall(`${CLIENT}__get-item`, {}, undefined);
      expect(result.isError).toBe(true);
      expect(fetchCalled).toBe(false);
    } finally {
      (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
    }
  });
});

describe("proxyToolCall — circuit breaker per-client override", () => {
  test("a client guard with a low failure threshold opens the breaker sooner than the global default", async () => {
    await reg();
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const first = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(first.isError).toBe(true);

    // With failureThreshold=1, a single failure should already have opened the breaker.
    const second = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/circuit breaker open/i);
  });
});
