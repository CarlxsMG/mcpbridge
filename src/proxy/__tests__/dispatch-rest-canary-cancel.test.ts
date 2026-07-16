/**
 * Regression tests for two dispatch-rest.ts fixes:
 *
 *  - Finding #5 (P2): a call routed to the canary SECONDARY must not resolve the
 *    PRIMARY breaker's half-open probe. When canRequest() admits a half-open
 *    probe and a 100%-weight canary then routes that same call to the (healthy)
 *    secondary, the secondary's success previously ran recordSuccess() against
 *    the primary breaker (bypassBreaker is set only for failover), wrongly
 *    closing it — breaker flapping driven by the wrong backend's health. The fix
 *    releases the probe (no health recorded) so the breaker stays half_open.
 *
 *  - Finding #6 (P2): the REST fetch never composed opts.signal, so an MCP
 *    notifications/cancelled could not abort an in-flight REST call. The fix
 *    threads opts.signal into the composed AbortSignal AND treats an opts.signal
 *    abort as caller-cancellation (not a breaker failure), mirroring
 *    dispatch-mcp.ts's result.cancelled handling.
 *
 * Both are driven through the public proxyToolCall entry point with mocked
 * fetch, exactly like the sibling proxy-mutation-c*.test.ts files.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { getCircuitBreaker, removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setCanary } from "../../tool-policies/canary.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const PREFIX = "dispcancel";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-item",
    method: "GET",
    endpoint: "/item",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}
async function reg(clientName: string): Promise<void> {
  await registry.register(clientName, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) {
    removeCircuitBreaker(c.name);
    await registry.unregister(c.name);
  }
  resetAll();
});

// ---------------------------------------------------------------------------
// Finding #5 — canary secondary must not resolve the primary's half-open probe
// ---------------------------------------------------------------------------
describe("Finding #5 — half-open probe routed to canary secondary must not close the primary breaker", () => {
  test("a successful canary-secondary probe leaves the primary breaker half_open (not closed)", async () => {
    const CLIENT = `${PREFIX}-probe`;
    await reg(CLIENT);
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30 } });

    // Primary (1.2.3.4) always fails; secondary (9.9.9.9) always succeeds.
    globalThis.fetch = (async (url: string) => {
      const host = new URL(String(url)).hostname;
      return host === "1.2.3.4"
        ? new Response("down", { status: 500 })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // Trip the breaker with a primary failure (no canary yet -> hits the primary).
    const r0 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r0.isError).toBe(true);
    expect(getCircuitBreaker(CLIENT).getState()).toBe("open");

    // Now attach a 100%-weight canary secondary.
    await setCanary(CLIENT, { secondaryBaseUrl: "http://9.9.9.9", mode: "canary", weight: 100, enabled: true });

    // Let resetTimeoutMs genuinely elapse so the next canRequest() transitions
    // open -> half_open and admits THIS call as the probe.
    await new Promise((r) => setTimeout(r, 80));

    // Call 2: half-open probe granted, but the canary routes it to the healthy
    // secondary. Its success must NOT be recorded against the primary breaker.
    const r1 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r1.isError).toBeUndefined();

    // FIXED: probe released, breaker stays half_open.
    // BUGGY (pre-fix): recordSuccess() ran while half_open -> breaker closed.
    expect(getCircuitBreaker(CLIENT).getState()).toBe("half_open");
  });
});

// ---------------------------------------------------------------------------
// Finding #6 — opts.signal cancels an in-flight REST call, not a breaker failure
// ---------------------------------------------------------------------------
describe("Finding #6 — opts.signal aborts an in-flight REST call as caller-cancellation", () => {
  test("aborting opts.signal returns a cancellation result and does NOT open the breaker", async () => {
    const CLIENT = `${PREFIX}-cancel`;
    await reg(CLIENT);
    // failureThreshold 1: if the cancellation were wrongly recorded as a failure,
    // the breaker would open — the assertion below catches exactly that.
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    // A fetch that only settles when its (composed) signal aborts — so if
    // opts.signal were NOT threaded into the composed signal, this would hang
    // and the test would time out (the second half of the regression).
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const p = proxyToolCall(`${CLIENT}__get-item`, {}, undefined, { signal: controller.signal });

    // Give the call a tick to reach fetch, then cancel it caller-side.
    await new Promise((r) => setTimeout(r, 15));
    controller.abort();

    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/cancelled by caller/i);
    // Caller-cancellation is not an upstream health signal -> breaker stays closed.
    expect(getCircuitBreaker(CLIENT).getState()).toBe("closed");
  });
});
