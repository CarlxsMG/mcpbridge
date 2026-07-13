import { config } from "../config.js";
import { log } from "../logger.js";
import { persistSpan } from "./trace-store.js";
import { getCurrentTraceContext, newSpanId, newTraceId, setCurrentSpan } from "./trace-context.js";
import { errorMessage } from "../lib/error-message.js";

/**
 * Dependency-free OpenTelemetry span export over OTLP/HTTP (JSON). When
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, a CLIENT span is emitted per proxied tool
 * call (bridge -> backend) and batched to the collector. No @opentelemetry SDK
 * dependency — the project deliberately leans on built-ins. Best-effort:
 * exporting never blocks or fails a tool call.
 */

export type AttrValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startMs: number;
  attributes: Record<string, AttrValue>;
  /**
   * W3C parent-span identifier when this span is a child of an upstream span
   * (the bridge honored an incoming `traceparent` header). Absent for root
   * spans — OTLP export omits the field in that case, matching the spec.
   */
  parentSpanId?: string;
}

export interface FinishedSpan extends Span {
  endMs: number;
  statusCode: 0 | 1 | 2; // UNSET / OK / ERROR
}

/** True when a span should be built at all — either OTLP export or the built-in trace-viewer storage (or both) is configured. */
export function tracingEnabled(): boolean {
  return Boolean(config.otelEndpoint) || config.traceStorageEnabled;
}

/**
 * Starts a span. Cheap; the export cost is deferred to the batched flush.
 *
 * If the calling request carried a valid W3C `traceparent` header (the
 * `requestIdMiddleware` parsed it into the async-local context), this span
 * inherits the upstream's trace-id and records the upstream's span-id as
 * its parent. Otherwise it starts a fresh trace as before.
 *
 * Side effect: registers this span as the request's "current span" so
 * outbound fetches can build a child `traceparent` header. The registration
 * is a no-op when no request context is active (bare tests).
 */
export function startSpan(name: string, attributes: Record<string, AttrValue> = {}): Span {
  const ctx = getCurrentTraceContext();
  const span: Span = ctx.traceparent
    ? {
        traceId: ctx.traceparent.traceId,
        spanId: newSpanId(),
        parentSpanId: ctx.traceparent.parentSpanId,
        name,
        startMs: Date.now(),
        attributes,
      }
    : { traceId: newTraceId(), spanId: newSpanId(), name, startMs: Date.now(), attributes };
  setCurrentSpan(span);
  return span;
}

const buffer: FinishedSpan[] = [];
let flushScheduled = false;

/**
 * Ends a span. No-op when neither OTLP export nor trace storage is enabled.
 * Independently: persists to SQLite for the built-in trace viewer
 * (opt-in, `TRACE_STORAGE`) and/or queues for OTLP export (opt-in,
 * `OTEL_EXPORTER_OTLP_ENDPOINT`) — a deployment can have either, both, or
 * neither without one implying the other.
 */
export function endSpan(span: Span, extraAttributes: Record<string, AttrValue> = {}, statusCode: 0 | 1 | 2 = 0): void {
  if (!tracingEnabled()) return;
  const finished: FinishedSpan = {
    ...span,
    attributes: { ...span.attributes, ...extraAttributes },
    endMs: Date.now(),
    statusCode,
  };

  if (config.traceStorageEnabled) persistSpan(finished);
  if (!config.otelEndpoint) {
    // Trace storage path doesn't need ALS cleanup, but the OTLP-disabled case
    // still leaves the span as the "current" one in the request context.
    // Clear it so a subsequent span in the same request doesn't accidentally
    // use this one as its parent.
    setCurrentSpan(null);
    return;
  }

  buffer.push(finished);
  setCurrentSpan(null);
  if (buffer.length >= config.otelMaxBatch) {
    void flush();
  } else if (!flushScheduled) {
    flushScheduled = true;
    const t = setTimeout(() => {
      flushScheduled = false;
      void flush();
    }, 2000);
    if (t.unref) t.unref();
  }
}

function toAnyValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

function msToNano(ms: number): string {
  // Millisecond precision is plenty here; append the six sub-ms zeros.
  return `${ms}000000`;
}

/** Builds an OTLP/HTTP JSON payload for a batch of spans. Exported for tests. */
export function buildOtlpPayload(spans: FinishedSpan[], serviceName: string): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: "mcp-rest-bridge" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 3, // SPAN_KIND_CLIENT
              startTimeUnixNano: msToNano(s.startMs),
              endTimeUnixNano: msToNano(s.endMs),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({ key, value: toAnyValue(value) })),
              status: { code: s.statusCode },
            })),
          },
        ],
      },
    ],
  };
}

/** Ships (and clears) the buffered spans to the OTLP endpoint. Best-effort. */
export async function flush(): Promise<void> {
  const endpoint = config.otelEndpoint;
  if (!endpoint || buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOtlpPayload(batch, config.otelServiceName)),
      redirect: "error",
      signal: AbortSignal.timeout(config.otelExportTimeoutMs),
    });
  } catch (err) {
    log("warn", "OTLP span export failed", {
      error: errorMessage(err),
      spans: batch.length,
    });
  }
}

export const _internalsForTesting = {
  bufferLength: () => buffer.length,
  clear: () => {
    buffer.length = 0;
    flushScheduled = false;
  },
};
