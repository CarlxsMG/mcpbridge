/**
 * Stryker mutation-testing backstop for src/observability/tracing.ts — domain 7.
 *
 * Baseline: 92 mutants, 50 killed / 42 survived. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Documented equivalents (verified, not assumed):
 *
 *   41:39-43:2 BlockStatement + 42:38-42:43 StringLiteral (genId's whole body
 *   / its "hex" encoding argument). `genId` is a module-private, never-
 *   exported helper with ZERO real call sites anywhere in the codebase — the
 *   very next line, `void genId;`, only REFERENCES the function value to
 *   silence an unused-declaration lint warning, it never INVOKES it (verified
 *   via a repo-wide grep for `genId(` finding only the function's own
 *   definition line). A function with no call site anywhere is unreachable
 *   by construction; no test can exercise its body.
 *
 *   77:32-77:34 ArrayDeclaration (`const buffer: FinishedSpan[] = [];`'s `[]`
 *   replaced with a sentinel array) and 78:22-78:27 BooleanLiteral (`let
 *   flushScheduled = false;`'s initial value flipped to `true`). Same
 *   "module-level DI-helper initial value is unreachable once a resetting
 *   beforeEach exists" equivalence class documented for load-balancer.ts's
 *   `nowFn` and quarantine.ts's cooldown clock: `_internalsForTesting.clear()`
 *   (called in every test file's own beforeEach) unconditionally does
 *   `buffer.length = 0; flushScheduled = false;` — `.length = 0` truncates
 *   ANY existing array content (including a sentinel string element) back to
 *   empty regardless of the initial value, and the direct reassignment
 *   overwrites the initial boolean the same way. Both initial values are
 *   overwritten before the first assertion of the first test ever runs.
 *
 *   116:9-116:16 ConditionalExpression true (`if (t.unref) t.unref();` forced
 *   always-true). A real `setTimeout()` return value in Node/Bun always has a
 *   callable `.unref` method — there is no code path in this file that could
 *   ever produce a timer object lacking it, so the guard's condition is
 *   already unconditionally true in every real invocation; forcing it to the
 *   literal `true` changes nothing observable. (The OPPOSITE mutant, forcing
 *   the condition false, is a real, killable gap — see the "unref'd" test
 *   below — since that direction WOULD suppress the call.)
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import * as loggerMod from "../../logger.js";
import * as traceStoreMod from "../../observability/trace-store.js";
import { getCurrentSpan, withTraceContext } from "../../observability/trace-context.js";
import {
  tracingEnabled,
  startSpan,
  endSpan,
  flush,
  buildOtlpPayload,
  _internalsForTesting,
} from "../../observability/tracing.js";
import type { FinishedSpan } from "../../observability/tracing.js";

const originalFetch = globalThis.fetch;
const originalEndpoint = config.otelEndpoint;
const originalStorage = config.traceStorageEnabled;
const originalMaxBatch = config.otelMaxBatch;

function resetAll(): void {
  (config as Record<string, unknown>).otelEndpoint = undefined;
  (config as Record<string, unknown>).traceStorageEnabled = false;
  (config as Record<string, unknown>).otelMaxBatch = originalMaxBatch;
  _internalsForTesting.clear();
  globalThis.fetch = originalFetch;
}
beforeEach(() => resetAll());
afterEach(() => {
  resetAll();
  (config as Record<string, unknown>).otelEndpoint = originalEndpoint;
  (config as Record<string, unknown>).traceStorageEnabled = originalStorage;
});

function okFetch(): void {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
}

describe("endSpan — fully-disabled tracing leaves the current span untouched", () => {
  // Kills 88:7-88:24 ConditionalExpression false (`if (!tracingEnabled())
  // return;` forced to never fire). With tracing fully disabled (neither
  // otelEndpoint nor traceStorageEnabled configured), real code returns
  // BEFORE `setCurrentSpan(null)` ever runs, leaving the started span as
  // "current". The existing "disabled" test only checks bufferLength (0
  // either way, via a DIFFERENT downstream guard) — never the current-span
  // side effect that actually isolates this specific early return.
  test("the started span remains the current span after endSpan, not cleared", () => {
    expect(tracingEnabled()).toBe(false);
    // setCurrentSpan is a no-op outside a real AsyncLocalStorage run (see its
    // own doc comment) -- a bare call would make this assertion vacuous
    // regardless of the mutation, so the whole check must run inside
    // withTraceContext, matching how a real request actually establishes it.
    withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () => {
      const s = startSpan("x");
      endSpan(s, {}, 1);
      expect(getCurrentSpan()?.spanId).toBe(s.spanId);
    });
  });
});

describe("endSpan — traceStorageEnabled gates persistSpan independently of OTLP", () => {
  // Kills 96:7-96:33 ConditionalExpression true (`if (config.traceStorageEnabled)
  // persistSpan(finished);` forced unconditional).
  test("persistSpan is NOT called when traceStorageEnabled is false, even with OTLP enabled", () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).traceStorageEnabled = false;
    const spy = spyOn(traceStoreMod, "persistSpan");
    try {
      endSpan(startSpan("x"), {}, 1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 97:7-97:27 ConditionalExpression false and 97:29-104:4
  // BlockStatement (the `if (!config.otelEndpoint) { ...; return; }` branch
  // disabled/emptied). Storage-only mode (traceStorageEnabled true,
  // otelEndpoint unset) must return BEFORE ever pushing to the OTLP buffer.
  test("storage-only mode (no otelEndpoint) never buffers a span for OTLP export", () => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
    (config as Record<string, unknown>).otelEndpoint = undefined;
    endSpan(startSpan("x"), {}, 1);
    expect(_internalsForTesting.bufferLength()).toBe(0);
  });
});

describe("endSpan — immediate-flush batch boundary", () => {
  // Kills 108:7-108:43 (ConditionalExpression false, EqualityOperator '>')
  // and 108:45-110:4 (BlockStatement, the immediate-flush body emptied). The
  // real `>=` boundary means a batch that reaches otelMaxBatch EXACTLY must
  // flush immediately; a `>` mutant would wait for one more span first.
  test("reaching otelMaxBatch exactly triggers an immediate flush", async () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 1;
    okFetch();
    endSpan(startSpan("x"), {}, 1);
    // void flush() is fire-and-forget; give its microtask a tick to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(_internalsForTesting.bufferLength()).toBe(0);
  });
});

describe("endSpan — deferred-flush scheduling", () => {
  // Kills 110:14-110:29 (BooleanLiteral 'flushScheduled', ConditionalExpression
  // true/false) and 183:22-183:27 (BooleanLiteral 'true' in
  // _internalsForTesting.clear — clear() must reset flushScheduled to
  // false, not true, or this very test's own beforeEach would poison it).
  test("a single below-threshold endSpan schedules exactly one deferred flush timer", () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      endSpan(startSpan("x"), {}, 1);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  // Kills 111:22-111:26 BooleanLiteral 'false' (`flushScheduled = true;`
  // flipped to `false`) — without the flag actually flipping to true, a
  // SECOND below-threshold call would wrongly schedule a second timer.
  test("a second below-threshold endSpan does NOT schedule a second timer while one is already pending", () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      endSpan(startSpan("a"), {}, 1);
      endSpan(startSpan("b"), {}, 1);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  // Kills 112:32-115:6 BlockStatement (the deferred timer's own callback body
  // emptied) and 113:24-113:29 BooleanLiteral 'true' (the callback's own
  // `flushScheduled = false;` flipped to `true`). Captures the real callback
  // via the setTimeout spy and invokes it directly instead of waiting out
  // the real 2s delay.
  test("firing the deferred timer's callback flushes the buffer and re-arms scheduling for the next span", () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    okFetch();
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      endSpan(startSpan("a"), {}, 1);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      const callback = timeoutSpy.mock.calls[0][0] as () => void;
      callback();
      // The real callback body flushes (async, fire-and-forget) — the
      // buffer being cleared happens synchronously inside flush() before
      // its own await, but splice() itself runs synchronously up front.
      expect(_internalsForTesting.bufferLength()).toBe(0);

      // If the callback's own flushScheduled reset were flipped to `true`
      // (id 113's mutant), this next below-threshold span would NOT
      // schedule a new timer.
      endSpan(startSpan("b"), {}, 1);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  // Kills 116:9-116:16 (ConditionalExpression true/false on `if (t.unref)
  // t.unref();`) — spies directly on the real timer's own .unref method
  // rather than inferring it from process-lifecycle side effects (which are
  // otherwise unobservable from inside a synchronous test).
  test("the deferred timer is unref'd so it never keeps the process alive on its own", () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    const realSetTimeout = globalThis.setTimeout;
    let unrefSpy: ReturnType<typeof spyOn> | undefined;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      const timer = realSetTimeout(cb, ms);
      unrefSpy = spyOn(timer, "unref");
      return timer;
    }) as typeof setTimeout);
    try {
      const t = endSpan(startSpan("x"), {}, 1);
      void t;
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("buildOtlpPayload — attribute value mapping", () => {
  const baseSpan: FinishedSpan = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "x",
    startMs: 1_700_000_000_000,
    endMs: 1_700_000_000_123,
    attributes: {},
    statusCode: 1,
  };

  // Kills 121:7-121:29 (ConditionalExpression false, StringLiteral "boolean"
  // emptied) and 121:38-121:54 (ObjectLiteral, `{ boolValue: v }` emptied).
  test("a boolean attribute maps to boolValue exactly", () => {
    const payload = buildOtlpPayload([{ ...baseSpan, attributes: { flag: true } }], "svc");
    const attrs = (
      ((payload.resourceSpans as Record<string, unknown>[])[0].scopeSpans as Record<string, unknown>[])[0]
        .spans as Record<string, unknown>[]
    )[0].attributes as { key: string; value: Record<string, unknown> }[];
    expect(attrs.find((a) => a.key === "flag")?.value).toEqual({ boolValue: true });
  });

  // Kills 122:7-122:28 (ConditionalExpression false, StringLiteral "number"
  // emptied), 122:59-122:82 (ObjectLiteral, `{ intValue: ... }` emptied), and
  // 122:85-122:103 (ObjectLiteral, `{ doubleValue: v }` emptied) — needs BOTH
  // an integer and a non-integer number to distinguish the two arms.
  test("an integer attribute maps to intValue (as a string) and a float maps to doubleValue", () => {
    const payload = buildOtlpPayload([{ ...baseSpan, attributes: { count: 5, ratio: 0.5 } }], "svc");
    const attrs = (
      ((payload.resourceSpans as Record<string, unknown>[])[0].scopeSpans as Record<string, unknown>[])[0]
        .spans as Record<string, unknown>[]
    )[0].attributes as { key: string; value: Record<string, unknown> }[];
    expect(attrs.find((a) => a.key === "count")?.value).toEqual({ intValue: "5" });
    expect(attrs.find((a) => a.key === "ratio")?.value).toEqual({ doubleValue: 0.5 });
  });

  // Kills 128:10-128:23 StringLiteral (the "000000" nanosecond-padding
  // template emptied) — the existing test only checks `typeof ===
  // "string"`, never the actual value.
  test("startTimeUnixNano/endTimeUnixNano are the millisecond value with six zeros appended", () => {
    const payload = buildOtlpPayload([baseSpan], "svc");
    const span = (
      ((payload.resourceSpans as Record<string, unknown>[])[0].scopeSpans as Record<string, unknown>[])[0]
        .spans as Record<string, unknown>[]
    )[0] as { startTimeUnixNano: string; endTimeUnixNano: string };
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000000123000000");
  });

  // Kills 139:20-139:47 (ObjectLiteral, the scope object emptied) and
  // 139:28-139:45 (StringLiteral, "mcp-rest-bridge" emptied) — the existing
  // test never inspects the `scope` field at all.
  test("the scope name is the fixed literal mcp-rest-bridge", () => {
    const payload = buildOtlpPayload([baseSpan], "svc");
    const scopeSpans = (payload.resourceSpans as Record<string, unknown>[])[0].scopeSpans as Record<string, unknown>[];
    expect((scopeSpans[0].scope as { name: string }).name).toBe("mcp-rest-bridge");
  });
});

describe("flush — the no-op guard's exact boolean logic", () => {
  // Kills 161:7-161:39 (ConditionalExpression false), 161:7-161:39
  // (LogicalOperator '||' -> '&&'), and 161:20-161:39 (ConditionalExpression
  // false on the second half). An endpoint-unset + non-empty-buffer
  // combination is the one input that distinguishes `||` from `&&`: real
  // `||` short-circuits true on `!endpoint` alone and returns early; a `&&`
  // mutant would require BOTH halves true, and with a non-empty buffer the
  // second half is false, so it would wrongly proceed to fetch.
  test("no endpoint configured never calls fetch, even with buffered spans present", async () => {
    (config as Record<string, unknown>).otelEndpoint = undefined;
    (config as Record<string, unknown>).otelMaxBatch = 100;
    // Populate the buffer via a storage-only endSpan call is impossible (it
    // returns before pushing) -- push directly through the OTLP path by
    // temporarily setting an endpoint, then clearing it before calling flush.
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    endSpan(startSpan("x"), {}, 1);
    expect(_internalsForTesting.bufferLength()).toBe(1);
    (config as Record<string, unknown>).otelEndpoint = undefined;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await flush();
    expect(fetchCalled).toBe(false);
  });

  // Kills 161:20-161:39 ConditionalExpression false (the second half,
  // `buffer.length === 0`, forced to never fire on its own). The scenario
  // above (endpoint unset, buffer non-empty) already isolates the FIRST
  // half; this one isolates the SECOND: with a configured endpoint and a
  // genuinely empty buffer, real code's `buffer.length === 0` is true,
  // short-circuiting the `||` to return early. Forcing that half to always
  // false would require BOTH halves false to skip the return, which never
  // happens here since `!endpoint` really is false too — so the mutant
  // wrongly proceeds to fetch with nothing to send.
  test("an empty buffer never calls fetch, even with a configured endpoint", async () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    expect(_internalsForTesting.bufferLength()).toBe(0);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await flush();
    expect(fetchCalled).toBe(false);
  });
});

describe("flush — the exact OTLP HTTP request shape", () => {
  // Kills 165:15-165:21 StringLiteral ("POST" emptied), 166:16-166:54
  // (ObjectLiteral, headers emptied) + 166:34-166:52 (StringLiteral,
  // "application/json" emptied), and 168:17-168:24 StringLiteral ("error"
  // redirect value emptied) — the existing test only inspects the request
  // BODY, never its method/headers/redirect.
  test("POSTs with a JSON content-type header and redirect: error", async () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    endSpan(startSpan("x"), {}, 1);

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await flush();
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(capturedInit?.redirect).toBe("error");
  });
});

describe("flush — export failure is logged, not thrown", () => {
  // Kills 171:17-176:4 (BlockStatement, whole catch body emptied),
  // 172:9-172:15 / 172:17-172:42 (StringLiteral, log level/message emptied),
  // and 172:44-175:6 (ObjectLiteral, the log meta object emptied).
  test("a rejected fetch is caught, logged with the exact level/message/meta, and does not throw", async () => {
    (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
    (config as Record<string, unknown>).otelMaxBatch = 100;
    endSpan(startSpan("x"), {}, 1);

    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    const logSpy = spyOn(loggerMod, "log");
    try {
      await expect(flush()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("warn", "OTLP span export failed", { error: "boom", spans: 1 });
    } finally {
      logSpy.mockRestore();
    }
  });
});
