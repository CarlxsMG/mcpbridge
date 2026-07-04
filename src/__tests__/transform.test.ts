/**
 * Declarative transform — pure applyOps, config persistence, and proxy
 * integration (request ops inject a field past Ajv strip; response ops reshape
 * the body before it reaches the caller).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { getToolTransform, setToolTransform, applyOps } from "../proxy/transform.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: {} },
};
const postTool: RestToolDefinition = {
  name: "post-x",
  method: "POST",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool, postTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
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

describe("applyOps", () => {
  test("set / remove / rename / copy on nested paths; input not mutated", () => {
    const input = { a: 1, keep: { x: 2 }, secret: "s" };
    const out = applyOps(input, [
      { op: "set", path: "meta.v", value: 9 },
      { op: "remove", path: "secret" },
      { op: "rename", from: "a", to: "b" },
      { op: "copy", from: "keep.x", to: "copied" },
    ]) as Record<string, unknown>;
    expect(out).toEqual({ b: 1, keep: { x: 2 }, meta: { v: 9 }, copied: 2 });
    expect(input).toEqual({ a: 1, keep: { x: 2 }, secret: "s" }); // untouched
  });

  test("array / non-object inputs pass through unchanged", () => {
    expect(applyOps([1, 2], [{ op: "remove", path: "0" }])).toEqual([1, 2]);
    expect(applyOps("hi", [{ op: "set", path: "x", value: 1 }])).toBe("hi");
  });
});

describe("config persistence", () => {
  test("unknown tool -> false; set/get; clear", async () => {
    await reg();
    expect(setToolTransform(CLIENT, "nope", { enabled: true, request: [], response: [] })).toBe(false);
    const cfg = { enabled: true, request: [{ op: "set" as const, path: "k", value: 1 }], response: [] };
    expect(setToolTransform(CLIENT, "get-x", cfg)).toBe(true);
    expect(getToolTransform(CLIENT, "get-x")).toEqual(cfg);
    expect(setToolTransform(CLIENT, "get-x", null)).toBe(true);
    expect(getToolTransform(CLIENT, "get-x")).toBeNull();
  });
});

describe("proxy integration", () => {
  test("request op injects a field that survives Ajv and reaches the backend", async () => {
    await reg();
    setToolTransform(CLIENT, "post-x", {
      enabled: true,
      request: [{ op: "set", path: "injected", value: "yes" }],
      response: [],
    });
    let sentBody: unknown;
    globalThis.fetch = (async (_url: string, opts: RequestInit) => {
      sentBody = JSON.parse(String(opts.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__post-x`, { a: "1" });
    expect(sentBody).toEqual({ a: "1", injected: "yes" });
  });

  test("response ops reshape the body before it returns", async () => {
    await reg();
    setToolTransform(CLIENT, "get-x", {
      enabled: true,
      request: [],
      response: [
        { op: "remove", path: "secret" },
        { op: "rename", from: "keep", to: "kept" },
      ],
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ secret: "x", keep: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(JSON.parse(r.content[0].text)).toEqual({ kept: 1 });
  });
});
