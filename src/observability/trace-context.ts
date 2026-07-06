/**
 * W3C Trace Context — minimal, dependency-free implementation.
 *
 * Implements the parser/serializer for the `traceparent` and `tracestate` headers
 * defined by https://www.w3.org/TR/trace-context/. Used by the gateway to:
 *
 *  1. Honor an incoming `traceparent` on an MCP request — the bridge's own
 *     span becomes a child of the caller's span, so a trace viewer stitches
 *     the two together instead of starting a fresh, disconnected trace.
 *  2. Inject a `traceparent` on outbound HTTP calls to backends (REST and
 *     MCP upstream) so the backend can keep the trace going.
 *  3. Pass through the W3C `tracestate` header (vendor-specific data) without
 *     modification, per the spec's "no modification" rule for forwarders.
 *
 * The AsyncLocalStorage plumbing is what makes (1) work without explicit
 * parameter threading through every layer: the request-id middleware parses
 * the header and enters a context, and `startSpan()` (in tracing.ts) reads
 * it back at span-creation time.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Parsed contents of a valid `traceparent` header. */
export interface ParsedTraceparent {
  /** Two-hex-char version. Today only "00" is emitted, but we tolerate future versions per the spec. */
  version: string;
  /** 32-hex-char trace identifier. Never all zeros — that value is forbidden by the spec. */
  traceId: string;
  /** 16-hex-char parent span identifier. Never all zeros. */
  parentSpanId: string;
  /** Two-hex-char trace-flags byte. */
  flags: string;
  /** Bit 0 of flags — true means the upstream asked us to record this trace. */
  sampled: boolean;
}

/** A minimal Span shape used by the trace-context ALS (avoids a circular type import from tracing.ts). */
export interface CurrentSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const FLAGS_RE = /^[0-9a-f]{2}$/;
const ALL_ZEROS_TRACE = "0".repeat(32);
const ALL_ZEROS_SPAN = "0".repeat(16);

/**
 * Parse a `traceparent` header value. Returns `null` on any deviation from
 * the spec — caller MUST treat null as "no parent, generate a fresh trace".
 * We do not throw because an MCP client sending garbage must not break a
 * tool call; the worst case is a slightly disconnected trace.
 */
export function parseTraceparent(raw: string | undefined | null): ParsedTraceparent | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  // Up to 4 fields are required; future versions may append more — we
  // intentionally don't reject extra fields beyond the first four.
  const parts = value.split("-");
  if (parts.length < 4) return null;
  const [version, traceId, parentSpanId, flags] = parts;
  if (version === "ff") return null; // reserved/invalid per spec
  if (!TRACE_ID_RE.test(traceId) || traceId === ALL_ZEROS_TRACE) return null;
  if (!SPAN_ID_RE.test(parentSpanId) || parentSpanId === ALL_ZEROS_SPAN) return null;
  if (!FLAGS_RE.test(flags)) return null;
  const flagByte = Number.parseInt(flags, 16);
  if (!Number.isFinite(flagByte)) return null;
  return {
    version,
    traceId,
    parentSpanId,
    flags,
    sampled: (flagByte & 0x01) === 0x01,
  };
}

/** Build a `traceparent` header value with the standard 4-field shape. */
export function formatTraceparent(traceId: string, parentSpanId: string, sampled: boolean): string {
  return `00-${traceId}-${parentSpanId}-${sampled ? "01" : "00"}`;
}

/**
 * Generate a fresh W3C-compliant trace id (32 lowercase hex chars; never all-zero).
 * Exposed so the bridge can mint its own trace when no upstream sent one.
 */
export function newTraceId(): string {
  let id = randomBytes(16).toString("hex");
  // Astronomically unlikely, but the spec says reject all-zero anyway.
  if (id === ALL_ZEROS_TRACE) id = newTraceId();
  return id;
}

/** Generate a fresh W3C-compliant span id (16 lowercase hex chars; never all-zero). */
export function newSpanId(): string {
  let id = randomBytes(8).toString("hex");
  if (id === ALL_ZEROS_SPAN) id = newSpanId();
  return id;
}

// ── Per-request context (AsyncLocalStorage) ──────────────────────────────────

/**
 * Context propagated across the async tree of a single HTTP request.
 * - `traceparent` is the parent's parsed header (or null if absent / malformed)
 * - `tracestate` is passed through verbatim per the W3C spec
 * - `currentSpan` is the bridge's own active span, set by `startSpan` and
 *   read by outbound fetch helpers to build a child `traceparent` header.
 *
 * Tests can also seed this via `withTraceContext(...)` to exercise the
 * inheritance path deterministically.
 */
export interface TraceContext {
  traceparent: ParsedTraceparent | null;
  tracestate: string | null;
  currentSpan: CurrentSpan | null;
}

const EMPTY_CONTEXT: TraceContext = { traceparent: null, tracestate: null, currentSpan: null };

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/** Return the current request's trace context, or an empty one outside any request. */
export function getCurrentTraceContext(): TraceContext {
  return traceContextStorage.getStore() ?? EMPTY_CONTEXT;
}

/** Run `fn` (and everything it awaits) inside the supplied trace context. */
export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return traceContextStorage.run(ctx, fn);
}

/**
 * Replace the current trace context's `currentSpan`. Only meaningful inside a
 * `withTraceContext` run — calling this from a bare test would leak the span
 * into the surrounding async tree, so we no-op when there's no context to
 * update. This is what `startSpan` uses internally; outbound helpers read
 * it back via `getCurrentSpan()`.
 */
export function setCurrentSpan(span: CurrentSpan | null): void {
  if (traceContextStorage.getStore() === undefined) return;
  const current = getCurrentTraceContext();
  traceContextStorage.enterWith({ ...current, currentSpan: span });
}

/** The currently active bridge span, or null outside a request / before startSpan. */
export function getCurrentSpan(): CurrentSpan | null {
  return getCurrentTraceContext().currentSpan;
}

// ── Outbound propagation ────────────────────────────────────────────────────

/**
 * Build a `traceparent` header value for an outbound call.
 *
 *   - If the request's trace context is present, reuse its trace-id and
 *     sampled bit so the upstream trace stays stitched to the caller's.
 *   - The parent-id is the supplied span's id (so the upstream's span is
 *     a direct child of the bridge's own span); when no span is given, a
 *     fresh span-id is generated — this is a degraded case (the upstream
 *     will not be linked to a real bridge span) and should be rare.
 */
export function buildOutboundTraceparent(spanId?: string): string | null {
  const ctx = getCurrentTraceContext();
  // If we have neither an inherited parent nor a span to advertise, do
  // nothing — generating a fresh trace on every fetch would be noise.
  if (!ctx.traceparent && !spanId) return null;
  const traceId = ctx.traceparent?.traceId ?? newTraceId();
  const parentSpanId = spanId ?? newSpanId();
  const sampled = ctx.traceparent?.sampled ?? true;
  return formatTraceparent(traceId, parentSpanId, sampled);
}

/**
 * Return headers (a fresh Headers instance) suitable for an outbound fetch,
 * with `traceparent`/`tracestate` set when a usable context exists. The
 * caller's own headers are merged in and take precedence on conflict.
 */
export function outboundTraceHeaders(spanId?: string, existing?: HeadersInit): Headers {
  const headers = new Headers(existing);
  const tp = buildOutboundTraceparent(spanId);
  if (tp !== null) headers.set("traceparent", tp);
  const ctx = getCurrentTraceContext();
  if (ctx.tracestate) headers.set("tracestate", ctx.tracestate);
  return headers;
}
