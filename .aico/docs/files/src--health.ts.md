---
id: file_3af7a948a77b8986
kind: file
source_path: src/health.ts
title: "Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.783Z
---

# Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction

**Path:** `src/health.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Implements a periodic health check loop for all registered MCP clients. Clients are polled in batches of 20 using `Promise.allSettled`, with HTTP requests issued against pinned IPs to prevent DNS rebinding attacks. Consecutive failures increment a per-client counter; once it hits `FAILURE_THRESHOLD` (3) the client is marked `unreachable`, and once it hits `config.maxConsecutiveFailures` the client is auto-evicted from the registry. Status transitions (healthy ↔ unreachable) and evictions trigger an MCP tools-changed notification. The exported `startHealthCheckLoop` runs an immediate check then schedules repeating checks, returning a teardown function.

# `src/health.ts` — Health Check Loop

## Purpose

Provides a self-contained, recurring health monitor for all clients registered in the [[src/registry.ts|registry]]. It ensures the MCP server only advertises tools from reachable clients, automatically healing status when a client recovers and auto-evicting persistently failing clients.

---

## Exports

### `startHealthCheckLoop(): () => void`

Starts the health check cycle:
1. Executes a check immediately (no cold-start delay).
2. Schedules a repeating interval at `config.healthCheckIntervalMs`.
3. Returns a **teardown function** (`() => clearInterval(timer)`) for graceful shutdown.

---

## Key Flows

### Batch Health Check (`checkBatch`)

```
getAllClients()
  → slice into batches of MAX_CONCURRENT_CHECKS (20)
    → for each client in batch (Promise.allSettled):
        1. Build pinned URL: swap hostname → client.resolved_ip, preserve Host header
        2. fetch(pinnedUrl, { redirect: "error", signal: AbortSignal.timeout(...) })
        3a. res.ok  → reset consecutive_failures to 0, markStatus("healthy")
                     → if previously not healthy: notifyToolsChanged()
        3b. !res.ok → handleFailure(name, previousStatus)
        3c. throw   → log warn, handleFailure(name, previousStatus)
```

### Failure Handling (`handleFailure`)

```
increment client.consecutive_failures
if >= FAILURE_THRESHOLD (3):
    markStatus("unreachable")
    if previously not unreachable: notifyToolsChanged()
    if >= config.maxConsecutiveFailures:
        log warn "Auto-evicting…"
        registry.unregister(name)
        notifyToolsChanged()
```

---

## DNS Rebinding Protection

All health requests are issued to the client's **resolved IP** (`client.resolved_ip`), not the hostname. The original hostname is passed as the `Host` header so the remote server still accepts the request. Redirects are blocked (`redirect: "error"`) to prevent redirect-based rebinding bypasses.

---

## Edge Cases & Gotchas

- **`Promise.allSettled`** ensures one failing fetch never aborts sibling checks in the same batch.
- A client deleted from the registry between the `getAllClients()` snapshot and the `handleFailure` call is silently skipped (`if (!client) return`).
- The immediate first-run means a newly started server begins evicting dead clients before the first interval fires.
- `AbortSignal.timeout(config.healthCheckTimeoutMs)` caps individual check latency, but if all 20 slots in a batch hang at the timeout limit, the total batch duration can be `healthCheckTimeoutMs` regardless of `healthCheckIntervalMs`.
- `notifyToolsChanged()` is called **three** distinct times on auto-eviction: once for unreachable promotion (if not already) and once explicitly after `unregister`. If the client was already `unreachable` before eviction, only the post-unregister call fires.

---

## References

### has_failure_mode
- [Batch timeout cascade](../knowledge/failure-modes/batch-timeout-cascade.md)
- [Ghost client mid-eviction](../knowledge/failure-modes/ghost-client-mid-eviction.md)
- [Double notifyToolsChanged on eviction](../knowledge/failure-modes/double-notifytoolschanged-on-eviction.md)
- [Fetch redirect throws silently swallowed](../knowledge/failure-modes/fetch-redirect-throws-silently-swallowed.md)
- [Config maxConsecutiveFailures ≤ FAILURE_THRESHOLD](../knowledge/failure-modes/config-maxconsecutivefailures-failure-threshold.md)

### has_pattern
- [IP-Pinned HTTP with Host Header Override](../knowledge/patterns/ip-pinned-http-with-host-header-override.md)
- [Hysteresis via Failure Threshold](../knowledge/patterns/hysteresis-via-failure-threshold.md)
- [Immediate-Then-Interval Scheduler](../knowledge/patterns/immediate-then-interval-scheduler.md)
- [Batched Promise.allSettled Concurrency](../knowledge/patterns/batched-promise-allsettled-concurrency.md)
- [Escalating Failure Response](../knowledge/patterns/escalating-failure-response.md)

### references
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [Auto-Eviction](../knowledge/concepts/auto-eviction.md)
- [Status Transition](../knowledge/concepts/status-transition.md)
- [Teardown Function](../knowledge/concepts/teardown-function.md)
- [Tools-Changed Notification](../knowledge/concepts/tools-changed-notification.md)
- [Failure Threshold](../knowledge/concepts/failure-threshold.md)
- [DNS Rebinding Protection](../knowledge/concepts/dns-rebinding-protection.md)
- [Batch Concurrency](../knowledge/concepts/batch-concurrency.md)
- [Consecutive Failure Counter](../knowledge/concepts/consecutive-failure-counter.md)
- [Redirect Guard](../knowledge/concepts/redirect-guard.md)
- [Health Check Loop](../knowledge/concepts/health-check-loop.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




