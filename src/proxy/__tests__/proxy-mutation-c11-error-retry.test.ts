/**
 * Stryker mutation-testing backstop — cluster C11 (proxy.ts L1074-1199):
 * non-retryable error response handling (with Retry-After wait + mock
 * fallback), retryable-status continue path, catch-block network-error
 * handling (retry vs give-up), retries-exhausted final response, and the
 * coalesce wrapper around the whole runRest closure.
 *
 * Every mutant is driven indirectly through the public proxyToolCall() entry
 * point (proxy.ts is module-private beyond that), using mocked fetch
 * responses/throws, retry/circuit-breaker config, and metrics/logger spies
 * exactly like the existing src/proxy/__tests__/*.test.ts files.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setToolMock } from "../../tool-meta/tool-mock.js";
import { setToolCoalesce } from "../../tool-policies/coalesce.js";
import { setLb, addUpstream, __resetLbForTesting } from "../../tool-policies/load-balancer.js";
import * as metrics from "../../observability/metrics.js";
import * as usageModule from "../../observability/usage.js";
import * as logger from "../../logger.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// Client names are validated against /^[a-z0-9][a-z0-9_-]{0,62}$/ (lowercase
// only) — "mutC11err" from the cluster's assigned prefix is lowercased here.
const CLIENT = "mutc11err";

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
async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  __resetDbForTesting();
  __resetLbForTesting();
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

// Loose-but-discriminating sanity bounds on duration values: catches
// ArithmeticOperator mutants that swap `-` for `+` (huge value, ~1e12+) or
// otherwise corrupt the computation, without being flaky on exact timing.
function expectSaneDurationMs(n: unknown): void {
  expect(typeof n).toBe("number");
  expect(n as number).toBeGreaterThanOrEqual(0);
  expect(n as number).toBeLessThan(5000);
}
function expectSaneDurationSeconds(n: unknown): void {
  expect(typeof n).toBe("number");
  expect(n as number).toBeGreaterThanOrEqual(0);
  expect(n as number).toBeLessThan(5);
}

// Records every `ms` argument passed to the global setTimeout while active,
// while still delegating to the real timer (so awaited promises resolve
// normally). More precise than elapsed-time bounds for distinguishing
// near-zero/absent waits: it observes whether a wait was *scheduled at all*,
// not just how long the whole call took.
function spyOnSetTimeoutDelays(): { delays: unknown[]; restore: () => void } {
  const original = globalThis.setTimeout;
  const delays: unknown[] = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    delays.push(ms);
    return original(fn as never, ms, ...rest);
  }) as typeof setTimeout;
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Non-retryable error response (L1079-1122)
// ---------------------------------------------------------------------------
describe("non-retryable error response", () => {
  test("4xx status returns exact error message and records error metrics/log meta (kills L1093,1094,1097,1101,1102,1104,1105,1108,1110,1111)", async () => {
    await reg();
    const toolCallSpy = spyOn(metrics, "recordToolCall");
    const usageSpy = spyOn(usageModule, "recordUsage");
    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      globalThis.fetch = (async () => new Response("bad request body", { status: 400 })) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("REST API returned 400: bad request body");

      // L1093/1094: proxyRequestDuration({client, method, status_class:"4xx"}, secondsNotMs)
      const durCall = durSpy.mock.calls.find((c) => (c[0] as Record<string, string>).status_class === "4xx");
      expect(durCall).toBeDefined();
      expect(durCall![0]).toEqual({ client: CLIENT, method: "GET", status_class: "4xx" });
      expectSaneDurationSeconds(durCall![1]);

      // L1104/1110/1111: recordToolCall(durationMs, true)
      const lastToolCall = toolCallSpy.mock.calls[toolCallSpy.mock.calls.length - 1];
      expect(lastToolCall[1]).toBe(true);
      expectSaneDurationMs(lastToolCall[0]);

      // L1105/1108: recordUsage(...) — statusClass/isError/keyId(null, no callerToken)
      const usageCall = usageSpy.mock.calls[usageSpy.mock.calls.length - 1][0];
      expect(usageCall).toMatchObject({
        clientName: CLIENT,
        toolName: "get-item",
        statusClass: "4xx",
        isError: true,
      });
      expect(usageCall.keyId).toBe(null);
      expectSaneDurationMs(usageCall.durationMs);

      // L1097/1101/1102: log("warn", "Tool call returned error", {...duration_ms, attempts:1})
      const warnCall = logSpy.mock.calls.find((c) => c[0] === "warn" && c[1] === "Tool call returned error");
      expect(warnCall).toBeDefined();
      const meta = warnCall![2] as Record<string, unknown>;
      expect(meta).toMatchObject({ tool: `${CLIENT}__get-item`, client: CLIENT, status: 400, attempts: 1 });
      expectSaneDurationMs(meta.duration_ms);
    } finally {
      toolCallSpy.mockRestore();
      usageSpy.mockRestore();
      durSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("non-retryable-error-response duration is computed in SECONDS (/1000), not inflated ms-as-seconds — a delayed mock fetch guarantees nonzero elapsed time (kills L1094 ArithmeticOperator->'*1000')", async () => {
    // Same 0-elapsed-time gotcha as the c10 success-path duration test: a
    // same-tick mocked fetch can leave `Date.now() - startTime === 0`, where
    // `/1000` and `*1000` are both 0 and indistinguishable. A real ~20ms wait
    // makes them diverge.
    await reg();
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("bad request body", { status: 400 });
    }) as unknown as typeof fetch;

    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    try {
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);

      const durCall = durSpy.mock.calls.find((c) => (c[0] as Record<string, string>).status_class === "4xx");
      expect(durCall).toBeDefined();
      // Real: ~20ms / 1000 -> ~0.02s. A '*1000' mutant would instead produce
      // ~20000 (thousands).
      expect(durCall![1] as number).toBeGreaterThan(0);
      expect(durCall![1] as number).toBeLessThan(1);
    } finally {
      durSpy.mockRestore();
    }
  });

  test("oversized error body is truncated via readBodyWithCap; falls back to the truncation message (kills L1116-1118)", async () => {
    await reg();
    const originalMax = config.maxResponseBytes;
    (config as Record<string, unknown>).maxResponseBytes = 1;
    try {
      globalThis.fetch = (async () =>
        new Response("this body is definitely more than one byte", { status: 400 })) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("REST API returned 400: [body truncated — exceeded 1 byte limit]");
    } finally {
      (config as Record<string, unknown>).maxResponseBytes = originalMax;
    }
  });

  test("mock fallback triggers only when enabled AND status>=500 — boundary pinned at 499 vs 500 (kills L1119 full set)", async () => {
    await reg();
    try {
      setToolMock(CLIENT, "get-item", { enabled: true, mode: "fallback", response: "FB" });

      globalThis.fetch = (async () => new Response("server err", { status: 500 })) as unknown as typeof fetch;
      const r500 = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r500.isError).toBeUndefined();
      expect(r500.content[0].text).toBe("FB");

      globalThis.fetch = (async () => new Response("client err", { status: 499 })) as unknown as typeof fetch;
      const r499 = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r499.isError).toBe(true);
      expect(r499.content[0].text).toBe("REST API returned 499: client err");

      // enabled:false leg — a 500 must NOT fall back when the mock is disabled.
      setToolMock(CLIENT, "get-item", { enabled: false, mode: "fallback", response: "FB" });
      globalThis.fetch = (async () => new Response("server err 2", { status: 500 })) as unknown as typeof fetch;
      const rDisabled = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(rDisabled.isError).toBe(true);
      expect(rDisabled.content[0].text).toBe("REST API returned 500: server err 2");
    } finally {
      setToolMock(CLIENT, "get-item", null);
    }
  });

  test("non-idempotent POST with a normally-retryable 503 status is NOT retried — single attempt, non-retryable path (kills L1079 isIdempotent leg)", async () => {
    await reg([makeTool({ name: "create-item", method: "POST", endpoint: "/item" })]);
    (config as Record<string, unknown>).retryMaxAttempts = 2; // budget that would matter IF it were idempotent
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__create-item`, {});
    expect(calls).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("REST API returned 503: unavailable");
  });
});

// ---------------------------------------------------------------------------
// Retryable-status continue path (L1079-1089)
// ---------------------------------------------------------------------------
describe("retryable-status continue path", () => {
  test("retryable 503 status is retried once (attempt < MAX_RETRIES) then succeeds (kills L1079 conjunction/boundary, L1080)", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const retrySpy = spyOn(metrics.proxyRetryAttempts, "inc");
    try {
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(calls).toBe(2);
      expect(
        retrySpy.mock.calls.some(
          (c) =>
            (c[0] as Record<string, string>).outcome === "retry" && (c[0] as Record<string, string>).method === "GET",
        ),
      ).toBe(true);
    } finally {
      retrySpy.mockRestore();
    }
  });

  test("429 Retry-After header is honored (waits ~1s) but a 429 with no header proceeds immediately (kills L1082,1083,1084,1085)", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;

    // Case A: retry-after present -> real wait before the retried attempt.
    let callsA = 0;
    globalThis.fetch = (async () => {
      callsA++;
      if (callsA === 1) return new Response("wait", { status: 429, headers: { "retry-after": "1" } });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const startA = Date.now();
    const rA = await proxyToolCall(`${CLIENT}__get-item`, {});
    const elapsedA = Date.now() - startA;
    expect(rA.isError).toBeUndefined();
    expect(callsA).toBe(2);
    expect(elapsedA).toBeGreaterThanOrEqual(900);

    // Case B: 429 with NO retry-after header -> only the tiny base retry
    // delay applies (retryBaseDelayMs=1), no ~1s wait.
    let callsB = 0;
    globalThis.fetch = (async () => {
      callsB++;
      if (callsB === 1) return new Response("wait", { status: 429 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const startB = Date.now();
    const rB = await proxyToolCall(`${CLIENT}__get-item`, {});
    const elapsedB = Date.now() - startB;
    expect(rB.isError).toBeUndefined();
    expect(callsB).toBe(2);
    expect(elapsedB).toBeLessThan(500);
  }, 10000);

  test("a retryable 503 that NEVER succeeds returns the immediate REST-error message at the last allowed attempt, not the exhausted-retries message (kills L1079 EqualityOperator-> '<=')", async () => {
    // Verified empirically: fetch call COUNT is identical (retryMaxAttempts+1)
    // under both the real `<` guard and the `<=` mutant, because the outer
    // attempt loop is itself bounded to `attempt <= MAX_RETRIES` — so an
    // extra `continue` at the mutant boundary doesn't add a fetch, it just
    // skips the immediate in-loop error return and falls through to the
    // *exhausted-retries* section after the loop instead, which does NOT
    // fetch again but DOES format a different final message/log/metric.
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 2;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    const retrySpy = spyOn(metrics.proxyRetryAttempts, "inc");
    try {
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(calls).toBe(3); // retryMaxAttempts(2) + 1 initial attempt — same under both real and mutant

      // Real: the last attempt (attempt===MAX_RETRIES) falls through to the
      // non-retryable-error-response branch and returns immediately with the
      // upstream body intact.
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("REST API returned 503: unavailable");

      // Real: only 2 "retry" outcomes fire (attempt 0 and 1); the mutant's
      // extra `continue` at attempt===2 fires a 3rd "retry" AND a trailing
      // "exhausted" outcome from the post-loop section.
      const outcomes = retrySpy.mock.calls.map((c) => (c[0] as Record<string, string>).outcome);
      expect(outcomes.filter((o) => o === "retry").length).toBe(2);
      expect(outcomes.filter((o) => o === "exhausted").length).toBe(0);
    } finally {
      retrySpy.mockRestore();
    }
  });

  test("a non-429 retryable status (503) that ALSO carries a retry-after header must NOT parse/apply it — only the standard backoff delay runs (kills L1082 ConditionalExpression->'true')", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("unavailable", { status: 503, headers: { "retry-after": "5" } });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { delays, restore } = spyOnSetTimeoutDelays();
    try {
      const start = Date.now();
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = Date.now() - start;
      expect(r.isError).toBeUndefined();
      expect(calls).toBe(2);
      // The real guard is gated on `response.status === 429`; for 503 the
      // whole Retry-After block must be skipped, so the parsed 5s (5000ms)
      // must never be scheduled — only the tiny exponential-backoff delay.
      expect(delays.some((d) => typeof d === "number" && d >= 1000)).toBe(false);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      restore();
    }
  }, 10000);

  test("429 Retry-After of exactly 0 seconds must NOT trigger a wait — waitMs=0 is the sole boundary where `!==null`/`>0` diverge from `||`/`>=0` mutants (kills L1084 ConditionalExpression->'true', LogicalOperator->'||', EqualityOperator->'>=0')", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("wait", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { delays, restore } = spyOnSetTimeoutDelays();
    try {
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(calls).toBe(2);
      // Real: `waitMs !== null && waitMs > 0` with waitMs=0 -> false -> no
      // setTimeout call is ever made carrying ms===0 for the retry-after
      // wait (the only other setTimeout call is the standard backoff delay,
      // which with BASE_DELAY=1 is always >= 1, never exactly 0).
      // A forced-true, `||`, or `>=0` mutant each flip this guard to true
      // for waitMs=0 and DO schedule setTimeout(resolve, 0) — observable.
      expect(delays.some((d) => d === 0)).toBe(false);
      expect(delays.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// Catch-block network-error handling (L1123-1153)
// ---------------------------------------------------------------------------
describe("catch-block network-error handling", () => {
  test("network error on non-idempotent POST gives up immediately with 'Failed to reach' + records error metrics (kills L1123,1125 !isIdempotent leg,1127,1128,1131,1135,1136,1138,1139,1142,1143,1144,1145,1150)", async () => {
    await reg([makeTool({ name: "create-item", method: "POST", endpoint: "/item" })]);
    (config as Record<string, unknown>).retryMaxAttempts = 2; // budget that would matter IF it were idempotent
    const toolCallSpy = spyOn(metrics, "recordToolCall");
    const usageSpy = spyOn(usageModule, "recordUsage");
    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__create-item`, {});
      expect(calls).toBe(1);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`Failed to reach ${CLIENT}: ECONNREFUSED`);

      const durCall = durSpy.mock.calls.find((c) => (c[0] as Record<string, string>).status_class === "error");
      expect(durCall).toBeDefined();
      expect(durCall![0]).toEqual({ client: CLIENT, method: "POST", status_class: "error" });
      expectSaneDurationSeconds(durCall![1]);

      const lastToolCall = toolCallSpy.mock.calls[toolCallSpy.mock.calls.length - 1];
      expect(lastToolCall[1]).toBe(true);
      expectSaneDurationMs(lastToolCall[0]);

      const usageCall = usageSpy.mock.calls[usageSpy.mock.calls.length - 1][0];
      expect(usageCall).toMatchObject({
        clientName: CLIENT,
        toolName: "create-item",
        statusClass: "error",
        isError: true,
      });
      expect(usageCall.keyId).toBe(null);
      expectSaneDurationMs(usageCall.durationMs);

      const errCall = logSpy.mock.calls.find((c) => c[0] === "error" && c[1] === "Tool call failed");
      expect(errCall).toBeDefined();
      const meta = errCall![2] as Record<string, unknown>;
      expect(meta).toMatchObject({
        tool: `${CLIENT}__create-item`,
        client: CLIENT,
        error: "ECONNREFUSED",
        attempts: 1,
      });
      expectSaneDurationMs(meta.duration_ms);
    } finally {
      toolCallSpy.mockRestore();
      usageSpy.mockRestore();
      durSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("caught-exception-branch duration is computed in SECONDS (/1000), not inflated ms-as-seconds — a delayed mock fetch guarantees nonzero elapsed time (kills L1128 ArithmeticOperator->'*1000')", async () => {
    // Same 0-elapsed-time gotcha as above: a same-tick throw can leave
    // `Date.now() - startTime === 0`, where `/1000` and `*1000` are both 0.
    // A real ~20ms wait before throwing makes them diverge. Uses the
    // non-idempotent POST leg (gives up immediately, no retry loop) so this
    // exercises the SAME branch as L1123-1150, distinct from the
    // exhausted-retries branch (L1160) covered elsewhere in this file.
    await reg([makeTool({ name: "create-item", method: "POST", endpoint: "/item" })]);
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    try {
      const r = await proxyToolCall(`${CLIENT}__create-item`, {});
      expect(r.isError).toBe(true);

      const durCall = durSpy.mock.calls.find((c) => (c[0] as Record<string, string>).status_class === "error");
      expect(durCall).toBeDefined();
      // Real: ~20ms / 1000 -> ~0.02s. A '*1000' mutant would instead produce
      // ~20000 (thousands).
      expect(durCall![1] as number).toBeGreaterThan(0);
      expect(durCall![1] as number).toBeLessThan(1);
    } finally {
      durSpy.mockRestore();
    }
  });

  test("network error on idempotent GET is retried once (attempt < MAX_RETRIES) then succeeds (kills L1125 negative boundary)", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const retrySpy = spyOn(metrics.proxyRetryAttempts, "inc");
    try {
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(calls).toBe(2);
      expect(
        retrySpy.mock.calls.some(
          (c) =>
            (c[0] as Record<string, string>).outcome === "retry" && (c[0] as Record<string, string>).method === "GET",
        ),
      ).toBe(true);
    } finally {
      retrySpy.mockRestore();
    }
  });

  test("mock fallback on a network error requires no status check and only applies when enabled (kills L1147 leg + enabled control)", async () => {
    await reg();
    try {
      setToolMock(CLIENT, "get-item", { enabled: true, mode: "fallback", response: "FB-net" });
      globalThis.fetch = (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("FB-net");

      // enabled:false -> real network-error message, not the mock.
      setToolMock(CLIENT, "get-item", { enabled: false, mode: "fallback", response: "FB-net" });
      globalThis.fetch = (async () => {
        throw new Error("down again");
      }) as unknown as typeof fetch;
      const rDisabled = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(rDisabled.isError).toBe(true);
      expect(rDisabled.content[0].text).toBe(`Failed to reach ${CLIENT}: down again`);
    } finally {
      setToolMock(CLIENT, "get-item", null);
    }
  });

  test("network error with NO mock configured at all (mockCfg===null) returns the clean 'Failed to reach' message, not a crash from touching .response on null (kills L1147 ConditionalExpression->'true')", async () => {
    await reg();
    // Deliberately no setToolMock call — getToolMock(...) returns null, so
    // `mockCfg?.enabled` short-circuits false via optional chaining in real
    // code. A forced-true guard would instead evaluate `mockCfg.response`
    // with mockCfg===null, throwing a TypeError that rejects the whole
    // proxyToolCall promise instead of returning a clean error result.
    globalThis.fetch = (async () => {
      throw new Error("no route to host");
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Failed to reach ${CLIENT}: no route to host`);
  });
});

// ---------------------------------------------------------------------------
// Retries-exhausted final response (L1156-1185)
//
// Reaching this section requires the for-loop to `break` (not `return`) out
// mid-retry — which happens when a half-open breaker's SECOND canRequest()
// call (at the top of a retry attempt) is rejected as "Probing" because the
// FIRST canRequest() call (at the top of runRest) already consumed the one
// half-open probe slot. Priming sequence: (1) a failing call with
// failureThreshold:1 opens the breaker; (2) resetTimeoutMs:0 means the very
// next canRequest() immediately flips open -> half_open and consumes the
// probe; (3) the retry loop's attempt>0 probe check is then rejected,
// `break`-ing out of the loop into the exhausted-retries section below with
// fewer real fetches than MAX_RETRIES+1.
// ---------------------------------------------------------------------------
describe("retries-exhausted final response", () => {
  async function primeHalfOpenBreaker(): Promise<void> {
    await registry.setClientGuards(CLIENT, {
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 0, halfOpenTimeoutMs: 5000, windowMs: 60000 },
    });
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const primer = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(primer.isError).toBe(true);
  }

  test("network error forced through the exhausted-retries path yields 'Failed after N attempts' with correct attempts count (kills L1125 boundary-via-break, L1157,1158-1160,1162,1163,1164,1168,1169,1171,1172,1175,1177,1178,1183,1184)", async () => {
    await reg();
    await primeHalfOpenBreaker();
    (config as Record<string, unknown>).retryMaxAttempts = 1;

    const toolCallSpy = spyOn(metrics, "recordToolCall");
    const usageSpy = spyOn(usageModule, "recordUsage");
    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    const retrySpy = spyOn(metrics.proxyRetryAttempts, "inc");
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);
      // MAX_RETRIES(1) + 1 = 2 attempts in the message (kills L1183 arithmetic/template).
      expect(r.content[0].text).toBe(`Failed after 2 attempts to reach ${CLIENT}: ECONNREFUSED`);

      expect(retrySpy.mock.calls.some((c) => (c[0] as Record<string, string>).outcome === "exhausted")).toBe(true);

      const durCall = durSpy.mock.calls.find(
        (c) =>
          (c[0] as Record<string, string>).status_class === "error" &&
          (c[0] as Record<string, string>).method === "GET",
      );
      expect(durCall).toBeDefined();
      expectSaneDurationSeconds(durCall![1]);

      const lastToolCall = toolCallSpy.mock.calls[toolCallSpy.mock.calls.length - 1];
      expect(lastToolCall[1]).toBe(true);
      expectSaneDurationMs(lastToolCall[0]);

      const usageCall = usageSpy.mock.calls[usageSpy.mock.calls.length - 1][0];
      expect(usageCall).toMatchObject({
        clientName: CLIENT,
        toolName: "get-item",
        statusClass: "error",
        isError: true,
      });
      expect(usageCall.keyId).toBe(null);
      expectSaneDurationMs(usageCall.durationMs);

      const exhaustedLog = logSpy.mock.calls.find((c) => c[0] === "error" && c[1] === "Tool call failed after retries");
      expect(exhaustedLog).toBeDefined();
      const meta = exhaustedLog![2] as Record<string, unknown>;
      // attempts: MAX_RETRIES + 1 = 2 (kills L1169 arithmetic).
      expect(meta).toMatchObject({ tool: `${CLIENT}__get-item`, client: CLIENT, error: "ECONNREFUSED", attempts: 2 });
      expectSaneDurationMs(meta.duration_ms);
    } finally {
      toolCallSpy.mockRestore();
      usageSpy.mockRestore();
      durSpy.mockRestore();
      retrySpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("HTTP status forced through the exhausted-retries path pins statusClass via `lastStatus ?? 0` (4xx, not the 0-fallback 5xx) (kills L1159/1176 ?? -> && )", async () => {
    await reg();
    await primeHalfOpenBreaker();
    (config as Record<string, unknown>).retryMaxAttempts = 1;

    const usageSpy = spyOn(usageModule, "recordUsage");
    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    try {
      // 408 is RETRYABLE_STATUSES but 4xx (unlike 503/5xx, whose httpStatusClass
      // fallback for `0` also happens to be "5xx" — an accidentally-equivalent
      // case). 408 discriminates `lastStatus ?? 0` (-> "4xx") from a `&&`
      // mutant (`408 && 0` -> 0 -> httpStatusClass(0) -> "5xx").
      globalThis.fetch = (async () => new Response("timeout", { status: 408 })) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`Failed after 2 attempts to reach ${CLIENT}: REST API returned 408`);

      const usageCall = usageSpy.mock.calls[usageSpy.mock.calls.length - 1][0];
      expect(usageCall.statusClass).toBe("4xx");

      const durCall = durSpy.mock.calls.find(
        (c) =>
          (c[0] as Record<string, string>).status_class === "4xx" && (c[0] as Record<string, string>).method === "GET",
      );
      expect(durCall).toBeDefined();
    } finally {
      usageSpy.mockRestore();
      durSpy.mockRestore();
    }
  });

  test("mock fallback wins over the real error even on the exhausted-retries path (kills L1180)", async () => {
    await reg();
    await primeHalfOpenBreaker();
    try {
      setToolMock(CLIENT, "get-item", { enabled: true, mode: "fallback", response: "FB-exhausted" });
      (config as Record<string, unknown>).retryMaxAttempts = 1;
      globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("FB-exhausted");
    } finally {
      setToolMock(CLIENT, "get-item", null);
    }
  });

  test("exhausted-retries duration is computed in SECONDS (/1000), not inflated ms-as-seconds — status-based path via primed breaker (kills L1160 ArithmeticOperator->'*1000')", async () => {
    await reg();
    await primeHalfOpenBreaker();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    const durSpy = spyOn(metrics.proxyRequestDuration, "observe");
    try {
      globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(r.isError).toBe(true);
      const durCall = durSpy.mock.calls.find(
        (c) =>
          (c[0] as Record<string, string>).status_class === "5xx" && (c[0] as Record<string, string>).method === "GET",
      );
      expect(durCall).toBeDefined();
      // Real elapsed time here is a handful of ms; /1000 keeps the observed
      // value well under 1 second. A `*1000` mutant would instead inflate it
      // into the thousands.
      expect(durCall![1]).toBeGreaterThanOrEqual(0);
      expect(durCall![1]).toBeLessThan(1);
    } finally {
      durSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Coalesce wrapper (L1192-1196)
// ---------------------------------------------------------------------------
describe("coalesce wrapper", () => {
  test("concurrent identical GET calls piggyback when coalescing is enabled: one fetch, coalesceHits increments once (kills L1192,1194)", async () => {
    await reg();
    setToolCoalesce(CLIENT, "get-item", { enabled: true });
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 50));
      return new Response(JSON.stringify({ n: fetchCount }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const hitsSpy = spyOn(metrics.coalesceHits, "inc");
    try {
      const [r1, r2] = await Promise.all([
        proxyToolCall(`${CLIENT}__get-item`, {}),
        proxyToolCall(`${CLIENT}__get-item`, {}),
      ]);
      expect(fetchCount).toBe(1);
      expect(r1.content[0].text).toBe(r2.content[0].text);
      expect(hitsSpy).toHaveBeenCalledTimes(1);
      expect(hitsSpy.mock.calls[0][0]).toEqual({ client: CLIENT });
    } finally {
      hitsSpy.mockRestore();
      setToolCoalesce(CLIENT, "get-item", null);
    }
  });

  test("coalescing DISABLED: concurrent identical GET calls each hit fetch independently; coalesceHits never fires (kills L1192 condition/BlockStatement)", async () => {
    await reg();
    // No setToolCoalesce call -> getToolCoalesce() is null -> coalesceCfg?.enabled is falsy.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 50));
      return new Response(JSON.stringify({ n: fetchCount }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const hitsSpy = spyOn(metrics.coalesceHits, "inc");
    try {
      await Promise.all([proxyToolCall(`${CLIENT}__get-item`, {}), proxyToolCall(`${CLIENT}__get-item`, {})]);
      expect(fetchCount).toBe(2);
      expect(hitsSpy).not.toHaveBeenCalled();
    } finally {
      hitsSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// finally block / per-target in-flight bookkeeping (L1186-1189)
// ---------------------------------------------------------------------------
describe("finally block: LB in-flight decrement", () => {
  test("decInflight in the finally block resets per-target counts so a completed call doesn't bias future least-conn selection (kills L1186 BlockStatement, L1188 Conditional)", async () => {
    await reg();
    await addUpstream(CLIENT, "http://5.6.7.8", 1);
    setLb(CLIENT, { strategy: "least-conn", primaryWeight: 1, enabled: true });

    let gatedOnce = false;
    let releasePrimary: (() => void) | undefined;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const host = new URL(String(url)).hostname;
      hosts.push(host);
      if (host === "1.2.3.4" && !gatedOnce) {
        gatedOnce = true;
        await primaryGate;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Call #1: both members tied at 0 in-flight -> pool[0] (primary) wins the
    // tie. Its fetch is gated so it stays "in flight" (inflight[primary]=1)
    // while call #2 runs.
    const p1 = proxyToolCall(`${CLIENT}__get-item`, {});
    await new Promise((r) => setTimeout(r, 20)); // let call #1 reach the gate

    // Call #2: primary now shows 1 in-flight, pool shows 0 -> routed to pool.
    // Its fetch is NOT gated, so it completes fully (including `finally`)
    // before we look at call #3.
    const r2 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r2.isError).toBeUndefined();

    // Call #3, while call #1 is STILL in flight: if the `finally` block (and
    // its `decInflight`) ran for call #2, pool is back to 0 (< primary's
    // still-live 1) -> routed to pool again. If the finally block/decInflight
    // was skipped, pool would be stuck at 1 too, tying with primary's 1 —
    // and the tie-break (pool[0]) would wrongly send call #3 to primary.
    const r3 = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(r3.isError).toBeUndefined();

    releasePrimary!();
    const r1 = await p1;
    expect(r1.isError).toBeUndefined();

    expect(hosts).toEqual(["1.2.3.4", "5.6.7.8", "5.6.7.8"]);
  });

  // L1188 ConditionalExpression->'true' (`if (lbKey) decInflight(lbKey)` forced
  // always-true) for the plain non-LB case (lbKey undefined) is EQUIVALENT —
  // verified empirically (see decInflight in ../../tool-policies/load-balancer.js):
  // `decInflight(undefined)` computes `(inflight.get(undefined) ?? 0) - 1` = -1,
  // takes the `n <= 0` branch, and calls `inflight.delete(undefined)`, which is a
  // silent no-op (the key was never present — only real lbKey strings are ever
  // set) that neither throws nor perturbs any other tracked key's count. A
  // `bun -e` repro (Map with a real "real-key" entry alongside a stray
  // `decInflight(undefined)` call) confirmed the other key's count is untouched
  // and `inflight.has(undefined)` stays false, so the forced-true and
  // real-guarded code paths are observationally identical through the public
  // proxyToolCall() API — there is no non-LB call shape that can distinguish them.
});
