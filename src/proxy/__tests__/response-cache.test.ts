/**
 * Response cache — per-tool config persistence, the in-memory TTL+LRU store, and
 * proxy integration (a GET hit skips the upstream; POST / disabled / purged /
 * reconfigured do not).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import {
  getToolCacheConfig,
  setToolCacheConfig,
  cacheKey,
  cacheGet,
  cacheSet,
  cacheSize,
  purgeToolCache,
  __resetCacheForTesting,
  __setClockForTesting,
} from "../../tool-policies/response-cache.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
};
const postTool: RestToolDefinition = {
  name: "post-y",
  method: "POST",
  endpoint: "/y",
  description: "y",
  inputSchema: { type: "object", properties: {} },
};

async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool, postTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

/** Installs a fetch stub that counts calls and echoes the call number as JSON. */
function countingFetch(): () => number {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response(JSON.stringify({ n }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return () => n;
}

const originalFetch = globalThis.fetch;

function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  __resetDbForTesting();
  __resetCacheForTesting();
  __setClockForTesting(null);
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
  test("unset -> null; set/get; unknown tool -> false; clear", async () => {
    await reg();
    expect(getToolCacheConfig(CLIENT, "get-x")).toBeNull();
    expect(setToolCacheConfig("ghost", "get-x", { enabled: true, ttlSeconds: 60 })).toBe(false);
    expect(setToolCacheConfig(CLIENT, "nope", { enabled: true, ttlSeconds: 60 })).toBe(false);
    expect(setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 60 })).toBe(true);
    expect(getToolCacheConfig(CLIENT, "get-x")).toEqual({ enabled: true, ttlSeconds: 60 });
    expect(setToolCacheConfig(CLIENT, "get-x", null)).toBe(true);
    expect(getToolCacheConfig(CLIENT, "get-x")).toBeNull();
  });
});

describe("in-memory store", () => {
  test("cacheKey is order-insensitive and base-URL scoped", () => {
    expect(cacheKey("c", "t", "http://u", { a: 1, b: 2 })).toBe(cacheKey("c", "t", "http://u", { b: 2, a: 1 }));
    expect(cacheKey("c", "t", "http://u", { a: 1 })).not.toBe(cacheKey("c", "t", "http://v", { a: 1 }));
  });

  test("get/set round-trips and TTL expires via the injectable clock", () => {
    __setClockForTesting(() => 1000);
    const v = { content: [{ type: "text", text: "hi" }] };
    cacheSet("k", v, 10); // expires at 11000
    expect(cacheGet("k")).toEqual(v);
    __setClockForTesting(() => 11001);
    expect(cacheGet("k")).toBeNull();
  });

  test("purgeToolCache drops only that tool's entries", () => {
    const kx = cacheKey(CLIENT, "get-x", "http://1.2.3.4", {});
    const ko = cacheKey(CLIENT, "other", "http://1.2.3.4", {});
    cacheSet(kx, { content: [{ type: "text", text: "a" }] }, 60);
    cacheSet(ko, { content: [{ type: "text", text: "b" }] }, 60);
    purgeToolCache(CLIENT, "get-x");
    expect(cacheGet(kx)).toBeNull();
    expect(cacheGet(ko)).not.toBeNull();
  });

  test("LRU eviction respects cacheMaxEntries", () => {
    const orig = config.cacheMaxEntries;
    (config as Record<string, unknown>).cacheMaxEntries = 2;
    try {
      cacheSet("k1", { content: [] }, 60);
      cacheSet("k2", { content: [] }, 60);
      cacheGet("k1"); // touch k1 so k2 becomes least-recently-used
      cacheSet("k3", { content: [] }, 60); // evicts k2
      expect(cacheGet("k2")).toBeNull();
      expect(cacheGet("k1")).not.toBeNull();
      expect(cacheGet("k3")).not.toBeNull();
      expect(cacheSize()).toBe(2);
    } finally {
      (config as Record<string, unknown>).cacheMaxEntries = orig;
    }
  });
});

describe("proxy integration", () => {
  test("a GET hit serves from cache without a second upstream call", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 60 });
    const calls = countingFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-x`, {});
    const r2 = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(r1.isError).toBeUndefined();
    expect(calls()).toBe(1);
    expect(r2.content[0].text).toBe(r1.content[0].text);
  });

  test("disabled config -> every call hits the upstream", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "get-x", { enabled: false, ttlSeconds: 60 });
    const calls = countingFetch();
    await proxyToolCall(`${CLIENT}__get-x`, {});
    await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(calls()).toBe(2);
  });

  test("POST is never cached even when configured", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "post-y", { enabled: true, ttlSeconds: 60 });
    const calls = countingFetch();
    await proxyToolCall(`${CLIENT}__post-y`, {});
    await proxyToolCall(`${CLIENT}__post-y`, {});
    expect(calls()).toBe(2);
  });

  test("purge forces a re-fetch", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 60 });
    const calls = countingFetch();
    await proxyToolCall(`${CLIENT}__get-x`, {});
    purgeToolCache(CLIENT, "get-x");
    await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(calls()).toBe(2);
  });

  test("changing config invalidates cached entries", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 60 });
    const calls = countingFetch();
    await proxyToolCall(`${CLIENT}__get-x`, {}); // populate
    setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 30 }); // purges
    await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(calls()).toBe(2);
  });

  test("different args are cached under different keys", async () => {
    await reg();
    setToolCacheConfig(CLIENT, "get-x", { enabled: true, ttlSeconds: 60 });
    const calls = countingFetch();
    await proxyToolCall(`${CLIENT}__get-x`, { a: "1" });
    await proxyToolCall(`${CLIENT}__get-x`, { a: "2" });
    await proxyToolCall(`${CLIENT}__get-x`, { a: "1" }); // hit
    expect(calls()).toBe(2);
  });
});
