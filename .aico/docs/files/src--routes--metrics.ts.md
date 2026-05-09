---
id: file_6df92858968f0ee1
kind: file
source_path: src/routes/metrics.ts
title: "Metrics Route — Tool Call, Session & Circuit Breaker Telemetry"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.787Z
---

# Metrics Route — Tool Call, Session & Circuit Breaker Telemetry

**Path:** `src/routes/metrics.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Exposes a GET /metrics endpoint (admin-gated) that aggregates runtime telemetry for an Express-based MCP gateway. Tracks total and error tool call counts, a rolling 100-sample average latency window, active session counts (streamable + SSE), registered client health from the client registry, and per-client circuit breaker states. Session count retrieval is injected externally via `setSessionCountGetter`, allowing decoupled transport layers to supply their own counts without a direct import dependency.

# `src/routes/metrics.ts`

## Purpose
Provides operational observability for the MCP gateway by surfacing a single JSON endpoint (`GET /metrics`) that consolidates key runtime statistics. Protected by `adminAuth` middleware to prevent public exposure.

---

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `recordToolCall(durationMs, isError)` | `function` | Increments tool call counters and appends `durationMs` to the rolling latency window. Call this after every tool invocation completes. |
| `setSessionCountGetter(fn)` | `function` | Injects the session count supplier function. Must be called during app bootstrap by transport layers (streamable HTTP, SSE) before the `/metrics` route is hit. |
| `metricsRoutes(app)` | `function` | Registers `GET /metrics` on the provided Express `app` instance. |

---

## Key Flows

### Tool Call Recording
`recordToolCall` is called externally on each tool execution:
1. Increments `totalToolCalls`; conditionally increments `errorToolCalls`.
2. Pushes `durationMs` into the `latencies` array.
3. Trims `latencies` to `MAX_LATENCY_WINDOW` (100) entries using `Array.shift()` — oldest sample is evicted.

### Metrics Endpoint (`GET /metrics`)
1. Request passes through [[adminAuth]] middleware; unauthorized requests are rejected before reaching the handler.
2. Fetches all clients from [[registry]] and partitions by `status === "healthy"`.
3. Calls the injected `getSessionCounts()` to obtain live `streamable` + `sse` counts.
4. Computes `avgLatency` — guarded: returns `0` when `latencies` is empty.
5. Calls [[getAllCircuitStates]] from [[circuit-breaker]] for per-client breaker snapshots.
6. Responds with a single JSON payload.

### Response Shape
```json
{
  "uptime_seconds": 3600,
  "active_sessions": { "streamable": 2, "sse": 1 },
  "registered_clients": { "total": 5, "healthy": 4, "unreachable": 1 },
  "tool_calls": { "total": 120, "errors": 3, "avg_latency_ms": 47 },
  "circuit_breakers": { ... }
}
```

---

## Edge Cases & Gotchas

- **Session count defaults to zero**: If `setSessionCountGetter` is never called, `getSessionCounts` returns `{ streamable: 0, sse: 0 }`. This is a silent no-op — no error is thrown, but session data will be misleading.
- **Rolling window is in-memory only**: Latencies reset on process restart; no persistence or histogram bucketing — use only for coarse averages.
- **`unreachable` is derived**, not tracked directly: `clients.length - healthy` means any non-`"healthy"` status contributes, including transient or unknown states.
- **Module-level mutable state**: `totalToolCalls`, `errorToolCalls`, `latencies`, and `startedAt` are module singletons. Tests or hot-reloads that import this module share state.
- **`startedAt` captures import time**, not server listen time. If the module is imported before the server fully starts, `uptime_seconds` may be marginally inflated.

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Inflated Uptime on Lazy Import](../knowledge/failure-modes/inflated-uptime-on-lazy-import.md)
- [Stale Zero Session Counts](../knowledge/failure-modes/stale-zero-session-counts.md)
- [Unreachable Count Miscategorization](../knowledge/failure-modes/unreachable-count-miscategorization.md)
- [Metrics State Lost on Restart](../knowledge/failure-modes/metrics-state-lost-on-restart.md)
- [Avg Latency Skew from Sparse Window](../knowledge/failure-modes/avg-latency-skew-from-sparse-window.md)

### has_pattern
- [Dependency Injection via Setter](../knowledge/patterns/dependency-injection-via-setter.md)
- [Rolling Window Aggregation](../knowledge/patterns/rolling-window-aggregation.md)
- [Snapshot Aggregation at Request Time](../knowledge/patterns/snapshot-aggregation-at-request-time.md)

### references
- [adminAuth](../knowledge/concepts/adminauth.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)
- [Circuit Breaker — Per-Client Fault Isolation with Idle Eviction](src--circuit-breaker.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [Uptime Counter](../knowledge/concepts/uptime-counter.md)
- [Admin Auth Gate](../knowledge/concepts/admin-auth-gate.md)
- [Client Registry](../knowledge/concepts/client-registry.md)
- [Tool Call Counter](../knowledge/concepts/tool-call-counter.md)
- [Circuit Breaker State Snapshot](../knowledge/concepts/circuit-breaker-state-snapshot.md)
- [Rolling Latency Window](../knowledge/concepts/rolling-latency-window.md)
- [Session Count Getter Injection](../knowledge/concepts/session-count-getter-injection.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)

### parent_of
- [src/routes — Express Route Handlers for MCP Proxy Gateway](../dirs/src--routes.md)




