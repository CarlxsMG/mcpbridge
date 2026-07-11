# W3C traceparent propagation through the proxy pipeline

- Status: accepted
- Date: 2026-07-06
- Deciders: CarlxsMG (SRE + architecture), Claude Sonnet 5 (review)

## Context and Problem Statement

The bridge has OTLP tracing (`src/observability/tracing.ts`) and the
Prometheus exporter (`src/observability/metrics.ts`) for the proxy pipeline,
but the spans it emits are **orphans**: every `mcp_proxy_request_duration_seconds`
histogram bucket has a fresh trace-id, so the bridge's view in Jaeger / Tempo /
Honeycomb shows a flat list of unrelated traces. The caller — typically an
agent host — has its own trace tree, and there is no way to correlate the
bridge's spans with it.

Without correlation, an operator chasing a slow tool call in their own trace
viewer cannot answer: did the bridge add 800 ms, or was it the upstream? Did
the breaker trip, or did the upstream 5xx? The `mcp_proxy_request_duration_seconds`
buckets are not sliceable by upstream trace.

The question: should we honor an incoming `traceparent` header and propagate
it to both the bridge's OTLP span (so the trace tree stitches together) and
the outbound fetch (so the upstream's own traces also live under the same
trace-id)?

## Decision Drivers

- **Industry standard.** W3C Trace Context (`traceparent`, `tracestate`) is
  the de-facto propagation format; OpenTelemetry, Jaeger, Datadog, and
  Honeycomb all emit and accept it. Adopting it is free interoperability
  with whatever trace viewer the operator already runs.
- **Malformed input must never fail the request.** An LLM-driven caller
  might send `traceparent: garbage`; we cannot 502 the whole MCP call
  because of a malformed header.
- **Per-request state without parameter threading.** The trace context has
  to be available in `proxyToolCall`, in the transport's pinned fetch, and
  in the OTLP exporter — without turning every signature into
  `(args, callerToken, opts, traceCtx)`.
- **Both REST and MCP upstreams.** The bridge dispatches to both, and the
  propagation has to work for both kinds of backend, not just one.

## Considered Options

- **A. New `traceparent` header only — ignore `tracestate` and don't emit
  on outbound.** Rejected: half the W3C spec; loses vendor-specific
  routing info (`tracestate`); the upstream's trace viewer won't stitch
  with the agent's.
- **B. Hand-thread the parsed trace context through every function
  signature.** Rejected: ripples through 5+ files (`proxyToolCall`,
  the upstream transport's `pinnedFetch`, the OTLP exporter, the
  request-id middleware, the system-tools dispatcher); every existing
  signature changes; every existing test would have to update.
- **C. Parse + enter an `AsyncLocalStorage` context per request; both
  inbound and outbound paths read from the ALS scope.** Chosen.

## Decision Outcome

Chosen option: **C — `AsyncLocalStorage` (ALS) with strict W3C parser /
serializer**.

Implementation lives in `src/observability/trace-context.ts`. The flow:

1. `requestIdMiddleware` parses the incoming `traceparent` (if any) and the
   `tracestate` (passed through verbatim, with a per-vendor length cap),
   and enters the ALS run for the rest of the request lifecycle.
2. `startSpan()` inherits the upstream `trace-id` and records the
   upstream `span-id` as its own parent. The OTLP exporter emits a
   `parentSpanId` attribute so trace viewers stitch correctly.
3. `outboundTraceHeaders()` returns the `traceparent` (and unchanged
   `tracestate`) the bridge should send on its outbound fetch — both
   REST (`src/proxy/proxy.ts`) and MCP upstream
   (`src/mcp/mcp-upstream.ts`'s transport-level fetch wrapper).
4. Malformed or missing headers are silently treated as "no parent" —
   never a hard error.

The parser handles every edge case the W3C spec calls out: all-zero
trace-id is rejected (per spec, this means "invalid"), non-hex characters
in the id are rejected, future-spec versions are tolerated by extracting
the 16-byte trace-id portion anyway, and the version byte is preserved
on serialize so a v00 upstream gets a v00 outbound.

### Consequences

- Good, because `mcp_proxy_request_duration_seconds` is now correlatable
  with the upstream trace in any W3C-compatible viewer — an operator can
  see exactly where the bridge's latency came from (auth check, breaker
  check, body serialization, fetch, response decoding).
- Good, because the ALS approach adds zero parameters to any existing
  signature; the migration is mechanical (no public API changes).
- Good, because the strict parser rejects malformed input cleanly instead
  of propagating garbage to the OTLP exporter.
- Good, because both REST and MCP upstreams are covered by the same
  helper, so future transports (e.g. WebSocket) get propagation for free.
- Bad, because `AsyncLocalStorage` adds a small per-request overhead
  (~1–2 µs per ALS read, per the Node docs). At our request volume this
  is unmeasurable, but worth knowing.
- Bad, because the bridge now reveals its parent `trace-id` to backends.
  An operator who treats their backend trace IDs as secrets has to
  trust the upstream not to log them — same exposure any service mesh
  has, but worth documenting.

### Confirmation

- `src/__tests__/trace-context.test.ts` — 39 tests covering parse,
  serialize, round-trip, malformed inputs (non-hex, all-zero, future
  version, wrong length, tracestate with vendor keys), the AsyncLocalStorage
  context, and the `outboundTraceHeaders()` helper.
- `e2e/mcp-protocol.spec.ts` exercises a real `tools/call` and the trace
  context survives end-to-end.
- `docs/architecture/slos.md` mentions trace correlation as a prerequisite
  for diagnosing SLO violations on latency buckets.

## More Information

- Commit: `aebe04b` — `feat(tracing): W3C traceparent propagation through
proxy pipeline (P1-6)`
- W3C spec: <https://www.w3.org/TR/trace-context/>
- Related code: `src/observability/trace-context.ts`,
  `src/middleware/request-id.ts`, `src/proxy/proxy.ts`,
  `src/mcp/mcp-upstream.ts`.
