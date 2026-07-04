/**
 * Request coalescing — concurrent identical in-flight REST GET calls share a
 * single upstream fetch; config CRUD; and it correctly does NOT coalesce
 * distinct args or non-GET methods.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import { getToolCoalesce, setToolCoalesce, runCoalesced, __resetCoalesceForTesting } from "../coalesce.js";
import type { RestToolDefinition } from "../mcp/types.js";

// A unique client name (not reused by any other test file) — proxy.ts's Ajv
// validator cache is keyed by `${clientName}::${toolName}` and is never
// invalidated within a test run, so reusing a generic name like "svc" here
// could pick up a stale compiled validator from another file's tool of the
// same name but a different schema.
const CLIENT = "coalesce-test-client";
function makeTool(name = "get-x", method: RestToolDefinition["method"] = "GET"): RestToolDefinition {
  return {
    name,
    method,
    endpoint: `/${name}`,
    description: "x",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
}
async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __resetCoalesceForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __resetCoalesceForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});

/**
 * A fetch mock that resolves on a microtask (like a real fetch would, just
 * without the delay). No artificial timers needed: dispatchToolCall runs
 * fully synchronously from proxyToolCall's entry through the coalescing
 * decision (all gates before it are synchronous SQLite reads), so firing
 * several `proxyToolCall(...)` calls back-to-back in the same array (as
 * `Promise.all([...])` does) already guarantees the first call registers
 * itself as in-flight before the second one is even invoked.
 */
function mockFetch(): { getCalls: () => number } {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { getCalls: () => fetchCalls };
}

describe("coalesce config CRUD", () => {
  test("get/set round-trips and clears on null", async () => {
    await reg();
    expect(getToolCoalesce(CLIENT, "get-x")).toBeNull();
    expect(setToolCoalesce(CLIENT, "get-x", { enabled: true })).toBe(true);
    expect(getToolCoalesce(CLIENT, "get-x")).toEqual({ enabled: true });
    expect(setToolCoalesce(CLIENT, "get-x", null)).toBe(true);
    expect(getToolCoalesce(CLIENT, "get-x")).toBeNull();
  });

  test("returns false for a tool that doesn't exist", () => {
    expect(setToolCoalesce(CLIENT, "ghost", { enabled: true })).toBe(false);
  });
});

describe("runCoalesced", () => {
  test("piggybacking callers share the leader's promise and result", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      return "value";
    };
    const [a, b, c] = await Promise.all([
      runCoalesced("k", factory),
      runCoalesced("k", factory),
      runCoalesced("k", factory),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual({ result: "value", piggybacked: false });
    expect(b).toEqual({ result: "value", piggybacked: true });
    expect(c).toEqual({ result: "value", piggybacked: true });
  });

  test("a later call with the same key after the first settles runs its own factory", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      return calls;
    };
    const first = await runCoalesced("k", factory);
    const second = await runCoalesced("k", factory);
    expect(first).toEqual({ result: 1, piggybacked: false });
    expect(second).toEqual({ result: 2, piggybacked: false });
  });
});

describe("coalescing integration via proxyToolCall", () => {
  test("N concurrent identical GET calls share a single upstream fetch", async () => {
    await reg();
    setToolCoalesce(CLIENT, "get-x", { enabled: true });
    const { getCalls } = mockFetch();

    const results = await Promise.all([
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
    ]);

    expect(getCalls()).toBe(1);
    for (const r of results) {
      expect(r.isError).toBeUndefined();
      expect(r.content[0]?.text).toContain("ok");
    }
  });

  test("distinct args are NOT coalesced", async () => {
    await reg();
    setToolCoalesce(CLIENT, "get-x", { enabled: true });
    const { getCalls } = mockFetch();

    await Promise.all([
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
      proxyToolCall("coalesce-test-client__get-x", { id: "2" }),
    ]);

    expect(getCalls()).toBe(2);
  });

  test("disabled coalescing issues one fetch per concurrent call", async () => {
    await reg();
    // No setToolCoalesce call — coalescing stays off for this tool.
    const { getCalls } = mockFetch();

    await Promise.all([
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
      proxyToolCall("coalesce-test-client__get-x", { id: "1" }),
    ]);

    expect(getCalls()).toBe(2);
  });

  test("a non-GET tool is never coalesced even if configured", async () => {
    await reg([makeTool("post-x", "POST")]);
    setToolCoalesce(CLIENT, "post-x", { enabled: true });
    const { getCalls } = mockFetch();

    await Promise.all([
      proxyToolCall("coalesce-test-client__post-x", { id: "1" }),
      proxyToolCall("coalesce-test-client__post-x", { id: "1" }),
    ]);

    expect(getCalls()).toBe(2);
  });
});
