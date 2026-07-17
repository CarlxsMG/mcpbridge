/**
 * Regression tests for two dispatch-rest.ts hardening findings:
 *
 *  - Finding #49 (P3) — GraphQL-over-HTTP failure hidden behind a 200. A GraphQL
 *    backend answers HTTP 200 even for a failed query/mutation, signalling the
 *    failure only in the body via a top-level `errors[]`. Previously the bridge
 *    treated every 2xx as a success, so such a call returned isError:false and
 *    the circuit breaker never opened. The fix marks the result isError:true AND
 *    records a breaker FAILURE, but ONLY for GraphQL-configured tools and ONLY
 *    when `data` is null/absent — a partial success (data present alongside
 *    errors) stays a success, and non-GraphQL tools are completely unaffected.
 *
 *  - Finding #18 (P2) — the circuit-breaker half-open probe must be released on
 *    EVERY exit from the dispatch body, including a throw during request building
 *    (before the backend dial). The obligation used to be scattered across
 *    several manual releaseProbe() sites and missed the throw path entirely,
 *    stranding the probe in-flight and wedging the breaker in half_open forever
 *    (every later call rejected as "Probing"). The fix consolidates it into a
 *    single `finally { if (probeGranted) breaker.releaseProbe(); }` wrapping the
 *    whole body.
 *
 * Both are driven through the public proxyToolCall entry point with mocked
 * fetch, exactly like the sibling dispatch-rest-canary-cancel.test.ts file.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { getCircuitBreaker, removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolGraphql } from "../../proxy/backends.js";
import * as upstreamAuth from "../../backend-auth/upstream-auth.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const PREFIX = "dispgqlprobe";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "run",
    method: "POST",
    endpoint: "/graphql",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(clientName: string, tool: RestToolDefinition = makeTool()): Promise<void> {
  await registry.register(clientName, [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

/** A fetch that always answers with the given JSON body + status. */
function jsonFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
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
// Finding #49 — GraphQL 200-with-errors handling
// ---------------------------------------------------------------------------
describe("Finding #49 — a GraphQL 200 with errors[] and null data is a failure", () => {
  test("errors[] + null data -> isError:true AND the breaker records a failure", async () => {
    const CLIENT = `${PREFIX}-gqlerr`;
    await reg(CLIENT);
    setToolGraphql(CLIENT, "run", { enabled: true, query: "query { boom }" });
    // failureThreshold 1 so a single GraphQL error is enough to open the breaker —
    // proving the failure was recorded, not swallowed by the 2xx status.
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    globalThis.fetch = jsonFetch(JSON.stringify({ data: null, errors: [{ message: "boom" }] }));

    const r = await proxyToolCall(`${CLIENT}__run`, {});
    expect(r.isError).toBe(true);
    // The body still reaches the caller (the errors payload is informative).
    expect(r.content[0].text).toContain("boom");
    // Breaker recorded a failure -> opened (would stay closed pre-fix).
    expect(getCircuitBreaker(CLIENT).getState()).toBe("open");
  });

  test("errors[] with `data` ABSENT (not just null) is also a failure", async () => {
    const CLIENT = `${PREFIX}-gqlabsent`;
    await reg(CLIENT);
    setToolGraphql(CLIENT, "run", { enabled: true, query: "query { boom }" });
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    // No `data` key at all — GraphQL omits it when execution never started.
    globalThis.fetch = jsonFetch(JSON.stringify({ errors: [{ message: "syntax error" }] }));

    const r = await proxyToolCall(`${CLIENT}__run`, {});
    expect(r.isError).toBe(true);
    expect(getCircuitBreaker(CLIENT).getState()).toBe("open");
  });

  test("a partial success (data present alongside errors) STAYS a success", async () => {
    const CLIENT = `${PREFIX}-gqlpartial`;
    await reg(CLIENT);
    setToolGraphql(CLIENT, "run", { enabled: true, query: "query { field }" });
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    globalThis.fetch = jsonFetch(JSON.stringify({ data: { field: "ok" }, errors: [{ message: "field-level" }] }));

    const r = await proxyToolCall(`${CLIENT}__run`, {});
    expect(r.isError).toBeUndefined();
    // Conservative: partial success must not trip the breaker.
    expect(getCircuitBreaker(CLIENT).getState()).toBe("closed");
  });

  test("a non-GraphQL tool whose 200 body happens to carry errors[]+null data is UNAFFECTED", async () => {
    const CLIENT = `${PREFIX}-restjson`;
    // No setToolGraphql call -> ordinary REST tool.
    await reg(CLIENT);
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1 } });

    globalThis.fetch = jsonFetch(JSON.stringify({ data: null, errors: [{ message: "not graphql" }] }));

    const r = await proxyToolCall(`${CLIENT}__run`, {});
    // A plain REST 200 is a success even if the JSON shape resembles a GraphQL error.
    expect(r.isError).toBeUndefined();
    expect(getCircuitBreaker(CLIENT).getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Finding #18 — half-open probe released on a throw during request building
// ---------------------------------------------------------------------------
describe("Finding #18 — a throw before the backend dial releases the half-open probe", () => {
  test("getUpstreamAuthHeaders throwing on the probe call does not strand the probe", async () => {
    const CLIENT = `${PREFIX}-throw`;
    await reg(CLIENT, makeTool({ name: "get-item", method: "GET", endpoint: "/item" }));
    await registry.setClientGuards(CLIENT, { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30 } });

    // Step 1: trip the breaker with one primary failure -> open.
    globalThis.fetch = jsonFetch("down", 500);
    const r0 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r0.isError).toBe(true);
    expect(getCircuitBreaker(CLIENT).getState()).toBe("open");

    // Let the reset timeout elapse so the NEXT canRequest() transitions
    // open -> half_open and admits that call as the sole probe.
    await new Promise((r) => setTimeout(r, 60));

    // Step 2: the probe call throws inside buildRestRequest (credential
    // resolution) BEFORE any backend dial. The probe must be released by the
    // consolidated finally, not stranded in-flight.
    const authSpy = spyOn(upstreamAuth, "getUpstreamAuthHeaders").mockImplementation(() => {
      throw new Error("boom-credential-resolution");
    });
    try {
      await expect(proxyToolCall(`${CLIENT}__get-item`, {})).rejects.toThrow(/boom-credential-resolution/);
    } finally {
      authSpy.mockRestore();
    }

    // Step 3: with the probe released, the breaker is still half_open (probeInFlight
    // cleared), so this call is admitted as a fresh probe. A healthy backend then
    // closes the breaker. Pre-fix the probe would be stranded -> this call is
    // rejected as "Probing" (fail-fast "Circuit breaker OPEN") and never closes it.
    globalThis.fetch = jsonFetch("{}", 200);
    const r2 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r2.isError).toBeUndefined();
    expect(getCircuitBreaker(CLIENT).getState()).toBe("closed");
  });
});
