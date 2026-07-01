import { randomBytes } from "crypto";
import { config } from "../config.js";
import { log } from "../logger.js";

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
}

interface FinishedSpan extends Span {
  endMs: number;
  statusCode: 0 | 1 | 2; // UNSET / OK / ERROR
}

export function tracingEnabled(): boolean {
  return Boolean(config.otelEndpoint);
}

function genId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Starts a span. Cheap; the export cost is deferred to the batched flush. */
export function startSpan(name: string, attributes: Record<string, AttrValue> = {}): Span {
  return { traceId: genId(16), spanId: genId(8), name, startMs: Date.now(), attributes };
}

const buffer: FinishedSpan[] = [];
let flushScheduled = false;

/** Ends a span and queues it for export (no-op when tracing is disabled). */
export function endSpan(span: Span, extraAttributes: Record<string, AttrValue> = {}, statusCode: 0 | 1 | 2 = 0): void {
  if (!tracingEnabled()) return;
  buffer.push({ ...span, attributes: { ...span.attributes, ...extraAttributes }, endMs: Date.now(), statusCode });
  if (buffer.length >= config.otelMaxBatch) {
    void flush();
  } else if (!flushScheduled) {
    flushScheduled = true;
    const t = setTimeout(() => { flushScheduled = false; void flush(); }, 2000);
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
    log("warn", "OTLP span export failed", { error: err instanceof Error ? err.message : String(err), spans: batch.length });
  }
}

export const _internalsForTesting = {
  bufferLength: () => buffer.length,
  clear: () => { buffer.length = 0; flushScheduled = false; },
};
