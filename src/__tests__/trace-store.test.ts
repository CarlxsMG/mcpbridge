/**
 * SQLite-persisted spans for the trace viewer — opt-in write behavior
 * (nothing written when TRACE_STORAGE is off, regardless of OTLP config),
 * list/detail read shapes, and retention pruning.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import {
  tracingEnabled,
  startSpan,
  endSpan,
  _internalsForTesting as tracingInternals,
} from "../observability/tracing.js";
import {
  listTraces,
  getTrace,
  pruneSpans,
  purgeAllSpans,
  __clearSpansForTesting,
} from "../observability/trace-store.js";

const origTraceStorage = config.traceStorageEnabled;
const origOtelEndpoint = config.otelEndpoint;
const origRetention = config.traceRetentionMs;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
  (config as Record<string, unknown>).traceStorageEnabled = false;
  (config as Record<string, unknown>).otelEndpoint = undefined;
  (config as Record<string, unknown>).traceRetentionMs = origRetention;
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  __clearSpansForTesting();
  tracingInternals.clear();
  (config as Record<string, unknown>).traceStorageEnabled = origTraceStorage;
  (config as Record<string, unknown>).otelEndpoint = origOtelEndpoint;
  (config as Record<string, unknown>).traceRetentionMs = origRetention;
  globalThis.fetch = originalFetch;
});

function spanRowCount(): number {
  return (getDb().query(`SELECT COUNT(*) as c FROM tool_spans`).get() as { c: number }).c;
}

describe("opt-in write behavior", () => {
  test("nothing is written when TRACE_STORAGE is off, even with no OTLP endpoint either", () => {
    const span = startSpan("tool_call svc__do-x", { "mcp.tool": "svc__do-x" });
    endSpan(span, {}, 1);
    expect(spanRowCount()).toBe(0);
    expect(tracingEnabled()).toBe(false);
  });

  test("a span is persisted when TRACE_STORAGE is on, regardless of whether otelEndpoint is set", () => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
    expect(tracingEnabled()).toBe(true);
    const span = startSpan("tool_call svc__do-x", { "mcp.tool": "svc__do-x" });
    endSpan(span, {}, 1);
    expect(spanRowCount()).toBe(1);

    const trace = getTrace(span.traceId);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      traceId: span.traceId,
      spanId: span.spanId,
      mcpToolName: "svc__do-x",
      statusCode: 1,
    });
  });

  test("storage and OTLP export are independent — storage-only mode never calls fetch", async () => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
    (config as Record<string, unknown>).otelEndpoint = undefined;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const span = startSpan("tool_call svc__do-x", {});
    endSpan(span, {}, 0);
    expect(spanRowCount()).toBe(1);
    expect(fetchCalls).toBe(0); // no OTLP endpoint configured -> flush is never scheduled
  });

  test("both storage and OTLP can be enabled together", () => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
    (config as Record<string, unknown>).otelEndpoint = "http://collector.test/v1/traces";
    const span = startSpan("tool_call svc__do-x", {});
    endSpan(span, {}, 0);
    expect(spanRowCount()).toBe(1);
    expect(tracingInternals.bufferLength()).toBe(1); // queued for OTLP export too
  });
});

describe("listTraces / getTrace", () => {
  beforeEach(() => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
  });

  test("groups spans by trace_id and reports aggregate start/end/status", () => {
    const s1 = startSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    endSpan(s1, {}, 1);
    const s2 = startSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    endSpan(s2, {}, 2);

    const traces = listTraces().items;
    expect(traces).toHaveLength(2);
    const errored = traces.find((t) => t.traceId === s2.traceId)!;
    expect(errored.hasError).toBe(true);
    expect(errored.mcpToolName).toBe("svc__b");
    const ok = traces.find((t) => t.traceId === s1.traceId)!;
    expect(ok.hasError).toBe(false);
  });

  test("filters by mcpToolName", () => {
    const s1 = startSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    endSpan(s1, {}, 1);
    const s2 = startSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    endSpan(s2, {}, 1);

    expect(listTraces({ mcpToolName: "svc__a" }).items.map((t) => t.traceId)).toEqual([s1.traceId]);
  });

  test("getTrace returns [] for an unknown trace id", () => {
    expect(getTrace("does-not-exist")).toEqual([]);
  });

  test("cursor pagination: newest-first by underlying span id, nextCursor set only when more groups remain", () => {
    const s1 = startSpan("tool_call svc__t1", { "mcp.tool": "svc__t1" });
    endSpan(s1, {}, 0);
    const s2 = startSpan("tool_call svc__t2", { "mcp.tool": "svc__t2" });
    endSpan(s2, {}, 0);
    const s3 = startSpan("tool_call svc__t3", { "mcp.tool": "svc__t3" });
    endSpan(s3, {}, 0);

    const page1 = listTraces({ limit: 2 });
    expect(page1.items.map((t) => t.traceId)).toEqual([s3.traceId, s2.traceId]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = listTraces({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((t) => t.traceId)).toEqual([s1.traceId]);
    expect(page2.nextCursor).toBeUndefined();
  });
});

describe("retention", () => {
  beforeEach(() => {
    (config as Record<string, unknown>).traceStorageEnabled = true;
  });

  test("pruneSpans deletes rows older than the retention window", () => {
    (config as Record<string, unknown>).traceRetentionMs = 1000;
    const span = startSpan("tool_call svc__old", {});
    endSpan(span, {}, 0);
    expect(spanRowCount()).toBe(1);

    const removed = pruneSpans(Date.now() + 5000); // simulate "later"
    expect(removed).toBe(1);
    expect(spanRowCount()).toBe(0);
  });

  test("purgeAllSpans deletes everything regardless of age", () => {
    const span = startSpan("tool_call svc__x", {});
    endSpan(span, {}, 0);
    expect(spanRowCount()).toBe(1);
    expect(purgeAllSpans()).toBe(1);
    expect(spanRowCount()).toBe(0);
  });
});
