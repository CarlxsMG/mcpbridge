import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Proxy retry — signal isolation
//
// Bug detected: if the composed AbortSignal from attempt-0 were reused on
// attempt-1 it would already be aborted, causing the second fetch to fail
// immediately instead of succeeding.
// ---------------------------------------------------------------------------

const CLIENT = "proxy-test-client";
const TOOL = "get-item";

// Speed up retry delays so tests complete fast.
const originalRetryBaseDelayMs = config.retryBaseDelayMs;
const originalRetryMaxAttempts = config.retryMaxAttempts;

beforeEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).retryMaxAttempts = 2;
  // Clean slate
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  removeCircuitBreaker(CLIENT);

  await registry.register(
    CLIENT,
    [
      {
        name: TOOL,
        method: "GET",
        endpoint: "/item",
        description: "get an item",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4"
  );
});

afterEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = originalRetryBaseDelayMs;
  (config as Record<string, unknown>).retryMaxAttempts = originalRetryMaxAttempts;
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  removeCircuitBreaker(CLIENT);
});

describe("proxyToolCall — signal isolation across retry attempts", () => {
  test("second fetch receives a fresh (non-aborted) signal after timeout on first attempt", async () => {
    // Track signals captured per fetch call
    const capturedSignals: AbortSignal[] = [];

    // First call: throws an AbortError (simulating a timeout)
    // Second call: returns 200 OK
    let callCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function fakeFetch(
      _url: string | URL | Request,
      options?: RequestInit
    ): Promise<Response> {
      callCount++;
      if (options?.signal) {
        capturedSignals.push(options.signal as AbortSignal);
      }
      if (callCount === 1) {
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      }
      // Return a real Response object on second call
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } as typeof fetch;

    try {
      const { proxyToolCall } = await import("../proxy.js");
      const result = await proxyToolCall(`${CLIENT}__${TOOL}`, {});

      // Must succeed on second attempt
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("text");

      // Both attempts must have fired
      expect(callCount).toBeGreaterThanOrEqual(2);

      // The signal passed to the second fetch must NOT be aborted at call time
      // (it was recorded before await resolved, so it reflects the state at invocation)
      expect(capturedSignals.length).toBeGreaterThanOrEqual(2);
      expect(capturedSignals[1].aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
