---
id: file_240806239bb48654
kind: file
source_path: src/proxy.ts
title: "src/proxy.ts — MCP Tool Call Proxy with Resilience"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.777Z
---

# src/proxy.ts — MCP Tool Call Proxy with Resilience

**Path:** `src/proxy.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Core proxy layer that routes MCP tool calls to backend REST API clients. Resolves tool names via the registry, validates args against JSON Schema, substitutes URL path parameters, pins requests to resolved IPs to prevent DNS rebinding, then executes HTTP requests with circuit-breaker gating, exponential-backoff retry (idempotent methods only), Retry-After header respect for 429s, and per-client AbortController tracking for cancellation. Records success/failure metrics and structured logs on every attempt. Returns a uniform MCP content envelope with an optional isError flag.

# src/proxy.ts — MCP Tool Call Proxy with Resilience

## Purpose
`proxy.ts` is the single execution path for all MCP tool calls. It bridges the MCP protocol layer to backend REST APIs with production-grade resilience: circuit breaking, retries, request cancellation, DNS-rebinding protection, and input validation.

---

## Exports

### `abortClientRequests(clientName: string): void`
Cancels every in-flight `AbortController` registered for the named client and clears the tracking set. Called externally (e.g. on client disconnect or registry eviction) to immediately terminate pending HTTP requests.

### `proxyToolCall(mcpToolName: string, args?: Record<string, unknown>)`
Main proxy entry point. Returns `{ content: Array<{type, text}>, isError?: boolean }` — the standard MCP tool-result envelope.

---

## Key Flow

```
mcpToolName + args
  │
  ├─ registry.resolveTool()       → unknown tool → isError
  ├─ client.status check          → unreachable → isError
  ├─ circuitBreaker.canRequest()  → OPEN → fail fast
  │
  ├─ Path param substitution      :param → encodeURIComponent(value)
  ├─ Schema validation            strip unknown keys, type-check known keys
  ├─ DNS rebinding protection     replace hostname with client.resolved_ip, preserve Host header
  │
  ├─ for attempt 0..MAX_RETRIES (idempotent only):
  │    ├─ fetch(url, { signal: AbortSignal.any([clientAbort, timeout]) })
  │    ├─ response.ok → breaker.recordSuccess(), parse body, return
  │    ├─ 429 + Retry-After → sleep, continue
  │    ├─ retryable status (408/429/502/503/504) → backoff, continue
  │    └─ other error → breaker.recordFailure(), return isError
  │
  └─ retries exhausted → breaker.recordFailure(), return isError
```

---

## Retry Strategy
- Only **idempotent** methods (`GET`, `DELETE`, `HEAD`) are retried (up to `MAX_RETRIES = 2`).
- Delay: `BASE_DELAY * 2^(attempt-1) + random(BASE_DELAY)` — exponential backoff with jitter.
- Retryable HTTP statuses: `408, 429, 502, 503, 504`.
- `429` responses with a `Retry-After` header delay up to 30 s before retrying.
- Circuit-breaker state is re-checked before each retry — an intervening OPEN aborts the loop.

---

## DNS Rebinding Protection
After building the request URL, the hostname is replaced with `client.resolved_ip` (pre-resolved at registration time) while the original `Host` header is preserved. This prevents an attacker-controlled DNS response from redirecting requests mid-flight.

---

## Request Cancellation
Every call to `trackRequest()` creates an `AbortController` stored in `inflightControllers` keyed by `client.name`. The fetch signal is `AbortSignal.any([reqController.signal, AbortSignal.timeout(effectiveTimeout)])` — either source can cancel. The `finally` block always calls `untrackRequest()` to prevent memory leaks.

---

## Circuit Breaker Integration
`getCircuitBreaker(client.name)` returns the shared breaker for that client. `canRequest()` returns `{ allowed, timeout? }` — a half-open probe uses a shorter effective timeout to limit blast radius. `recordSuccess()` / `recordFailure()` are called on every terminal outcome.

---

## Input Validation
When `tool.inputSchema.properties` is present:
1. Keys not in the schema are stripped from `remainingArgs` (not from the original `args`).
2. Known keys are type-checked (`string`, `number`/`integer`, `boolean`). A mismatch returns an `isError` response immediately without issuing a network request.
- **Note**: `array` and `object` schema types are not validated — only primitives are checked.

---

## Response Parsing
- `content-type: application/json` → `response.json()` pretty-printed; falls back to `response.text()` on parse failure.
- All other content types → raw `response.text()`.

---

## Gotchas
- `redirect: "error"` prevents silent redirects to attacker-controlled endpoints.
- Non-idempotent methods (`POST`, `PUT`, `PATCH`) are **never** retried, even on network errors.
- The retry loop `continue` after a 429 re-uses the same `fetchOptions` object including the same combined abort signal — if the timeout fires during the Retry-After sleep the next fetch will fail immediately.
- Unknown-key stripping operates on `remainingArgs` (a shallow copy of `args`), not the original, so path-param consumed keys are already absent.

---

## References

### has_dep
- [npm:TypeScript (built-in fetch / AbortController / AbortSignal)](../knowledge/deps/npm-typescript-built-in-fetch-abortcontroller-abortsignal.md)

### has_failure_mode
- [Stale Abort Signal on Retry After Sleep](../knowledge/failure-modes/stale-abort-signal-on-retry-after-sleep.md)
- [Unknown Tool Name](../knowledge/failure-modes/unknown-tool-name.md)
- [Argument Type Mismatch](../knowledge/failure-modes/argument-type-mismatch.md)
- [Request Timeout or Abort](../knowledge/failure-modes/request-timeout-or-abort.md)
- [Non-Idempotent Method Failure](../knowledge/failure-modes/non-idempotent-method-failure.md)
- [Retry Exhaustion](../knowledge/failure-modes/retry-exhaustion.md)
- [Circuit Breaker Open](../knowledge/failure-modes/circuit-breaker-open.md)
- [Client Unreachable](../knowledge/failure-modes/client-unreachable.md)

### has_pattern
- [Circuit Breaker](../knowledge/patterns/circuit-breaker.md)
- [Retry with Exponential Backoff and Jitter](../knowledge/patterns/retry-with-exponential-backoff-and-jitter.md)
- [Pinned-IP DNS Rebinding Protection](../knowledge/patterns/pinned-ip-dns-rebinding-protection.md)
- [AbortController Tracking for Bulk Cancellation](../knowledge/patterns/abortcontroller-tracking-for-bulk-cancellation.md)
- [Uniform Error Envelope](../knowledge/patterns/uniform-error-envelope.md)

### references
- [proxyToolCall](../knowledge/concepts/proxytoolcall.md)
- [abortClientRequests](../knowledge/concepts/abortclientrequests.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)
- [Circuit Breaker — Per-Client Fault Isolation with Idle Eviction](src--circuit-breaker.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [Retryable Status Set](../knowledge/concepts/retryable-status-set.md)
- [Exponential Backoff with Jitter](../knowledge/concepts/exponential-backoff-with-jitter.md)
- [Circuit Breaker](../knowledge/concepts/circuit-breaker.md)
- [Path Parameter Substitution](../knowledge/concepts/path-parameter-substitution.md)
- [Retry-After Respect](../knowledge/concepts/retry-after-respect.md)
- [MCP Tool Proxy](../knowledge/concepts/mcp-tool-proxy.md)
- [DNS Rebinding Protection](../knowledge/concepts/dns-rebinding-protection.md)
- [In-flight Request Tracking](../knowledge/concepts/in-flight-request-tracking.md)
- [Tool Resolution](../knowledge/concepts/tool-resolution.md)

## Backlinks

### references
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




