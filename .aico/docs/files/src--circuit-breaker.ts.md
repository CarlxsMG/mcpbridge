---
id: file_e1eabe1c60b4e3b6
kind: file
source_path: src/circuit-breaker.ts
title: "Circuit Breaker — Per-Client Fault Isolation with Idle Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.803Z
---

# Circuit Breaker — Per-Client Fault Isolation with Idle Eviction

**Path:** `src/circuit-breaker.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Implements the Circuit Breaker pattern for per-named-client request gating. Maintains a module-level `Map<string, CircuitBreaker>` registry with lazy singleton creation via `getCircuitBreaker`. The breaker cycles through three states: `closed` (normal), `open` (blocking, post-threshold failures), and `half_open` (single probe allowed after `resetTimeoutMs`). State transitions are driven by `canRequest`, `recordSuccess`, and `recordFailure`. A background `setInterval` evicts breakers idle beyond 5 minutes. No external runtime dependencies.

# `src/circuit-breaker.ts`

## Purpose

Provides per-client circuit breaker instances to protect downstream calls from cascading failures. Each named client gets one `CircuitBreaker` managed in a module-scoped registry. Callers check `canRequest()` before issuing a request and report outcomes via `recordSuccess()` / `recordFailure()`.

---

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `getCircuitBreaker(clientName)` | `function` | Returns (or lazily creates) the [[CircuitBreaker]] for `clientName`. |
| `getAllCircuitStates()` | `function` | Snapshot of every registered breaker's current [[CircuitState]]. |
| `removeCircuitBreaker(clientName)` | `function` | Manually evicts a breaker from the registry. |

---

## State Machine

```
         failure >= threshold
  CLOSED ────────────────────► OPEN
    ▲                            │
    │  recordSuccess()           │ resetTimeoutMs elapsed (lazy)
    │                            ▼
    └──────────────────── HALF_OPEN
          recordSuccess()   (one probe)
```

- **closed → open**: `recordFailure()` increments `failureCount`; when it reaches `failureThreshold` (default 3) the state flips to `open`.
- **open → half_open**: Evaluated lazily — both `canRequest()` (mutating) and `getState()` (non-mutating) detect elapsed `resetTimeoutMs` and return `half_open`. Only `canRequest()` actually writes `this.state`.
- **half_open → closed**: `recordSuccess()` resets failure count and closes the circuit.
- **half_open → open**: Any `recordFailure()` in `half_open` immediately re-opens.

---

## Key Flows

### Normal request gating
```ts
const cb = getCircuitBreaker("payments-api");
const { allowed, timeout } = cb.canRequest();
if (!allowed) throw new Error("circuit open");
try {
  await callApi({ timeout });
  cb.recordSuccess();
} catch {
  cb.recordFailure();
}
```

### Observability snapshot
```ts
const states = getAllCircuitStates();
// { "payments-api": "open", "inventory": "closed" }
```

---

## Configuration (`CircuitConfig`)

| Field | Default | Description |
|---|---|---|
| `failureThreshold` | `3` | Failures before opening. |
| `resetTimeoutMs` | `30_000` | Milliseconds to wait before allowing a half-open probe. |
| `halfOpenTimeoutMs` | `5_000` | Timeout hint returned with `canRequest()` during half-open. |

`getCircuitBreaker` always uses `DEFAULT_CONFIG`; custom config is only available via direct `new CircuitBreaker(name, config)` (not exported).

---

## Edge Cases & Gotchas

- **`_clientName` is unused** in the constructor body — it is accepted for API clarity but not stored, so two calls with different names but the same registry key behave identically.
- **`getState()` vs `canRequest()` divergence**: `getState()` computes the logical state without mutating `this.state`. If `open` has elapsed, it returns `"half_open"` but leaves the field as `"open"`. The mutation only happens on the next `canRequest()` call. External observers via `getAllCircuitStates()` may see `"half_open"` while `canRequest()` hasn't been called yet, and vice-versa.
- **No in-flight probe tracking**: During `half_open`, every concurrent `canRequest()` call returns `allowed: true`. Multiple requests can probe simultaneously without coordination.
- **`setInterval` is never cleared**: The idle-eviction timer is registered at module load and cannot be stopped, which may delay process shutdown or complicate test teardown.
- **Custom config not reachable via public API**: `getCircuitBreaker` always instantiates with defaults; per-client config tuning requires direct class instantiation.

---

## Idle Eviction

A `setInterval` running every `BREAKER_IDLE_TTL` (5 min) scans all registered breakers and deletes those whose `lastAccess` timestamp is older than 5 minutes. `lastAccess` is updated on every `canRequest()` call, not on `recordSuccess`/`recordFailure`.

---

## References

### has_failure_mode
- [Custom Config Unreachable via Public API](../knowledge/failure-modes/custom-config-unreachable-via-public-api.md)
- [Uncleared setInterval Blocking Shutdown](../knowledge/failure-modes/uncleared-setinterval-blocking-shutdown.md)
- [Half-Open Probe Stampede](../knowledge/failure-modes/half-open-probe-stampede.md)
- [lastAccess Not Updated on recordFailure](../knowledge/failure-modes/lastaccess-not-updated-on-recordfailure.md)
- [getState / canRequest State Divergence](../knowledge/failure-modes/getstate-canrequest-state-divergence.md)

### has_pattern
- [Lazy Singleton Registry](../knowledge/patterns/lazy-singleton-registry.md)
- [Circuit Breaker](../knowledge/patterns/circuit-breaker.md)
- [TTL-Based Idle Eviction](../knowledge/patterns/ttl-based-idle-eviction.md)
- [Lazy State Evaluation](../knowledge/patterns/lazy-state-evaluation.md)

### references
- [removeCircuitBreaker](../knowledge/concepts/removecircuitbreaker.md)
- [CircuitConfig](../knowledge/concepts/circuitconfig.md)
- [getCircuitBreaker](../knowledge/concepts/getcircuitbreaker.md)
- [CircuitBreaker](../knowledge/concepts/circuitbreaker.md)
- [CircuitState](../knowledge/concepts/circuitstate.md)

### uses_concept
- [Breaker Registry](../knowledge/concepts/breaker-registry.md)
- [Failure Threshold](../knowledge/concepts/failure-threshold.md)
- [Lazy State Transition](../knowledge/concepts/lazy-state-transition.md)
- [Idle Eviction](../knowledge/concepts/idle-eviction.md)
- [CircuitConfig](../knowledge/concepts/circuitconfig.md)
- [CircuitBreaker](../knowledge/concepts/circuitbreaker.md)
- [Half-Open Probe](../knowledge/concepts/half-open-probe.md)
- [halfOpenTimeoutMs](../knowledge/concepts/halfopentimeoutms.md)
- [CircuitState](../knowledge/concepts/circuitstate.md)
- [Reset Timeout](../knowledge/concepts/reset-timeout.md)

## Backlinks

### references
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




