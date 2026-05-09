---
id: file_bd4829d7c5e85fd0
kind: file
source_path: src/middleware/rate-limiter.ts
title: "Rate Limiter Middleware — Sliding Window, In-Memory"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.794Z
---

# Rate Limiter Middleware — Sliding Window, In-Memory

**Path:** `src/middleware/rate-limiter.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Express middleware module implementing a sliding-window rate limiter backed by an in-memory `Map`. Each bucket stores an array of request timestamps; entries older than 60 seconds are pruned on every check. A `setInterval` cleanup sweep runs every 5 minutes to evict empty buckets and prevent unbounded memory growth. Three middleware factories are exported: `rateLimitRegister` (keyed by client IP), `rateLimitMcp` (keyed by MCP session ID or IP), and `rateLimitGlobal` (single shared key). Exceeded limits respond with HTTP 429, a `Retry-After` header, and a structured JSON error body.

# `src/middleware/rate-limiter.ts`

## Purpose
Provides configurable, per-route rate limiting for an Express application using a **sliding-window** algorithm. All state is held in a module-level `Map`; there is no external store dependency.

---

## Exports

| Export | Signature | Description |
|---|---|---|
| `rateLimitRegister` | `(maxPerMinute: number) → Middleware` | Limits registration endpoint requests; keyed by `req.ip` or socket remote address. |
| `rateLimitMcp` | `(maxPerMinute: number) → Middleware` | Limits MCP endpoint requests; keyed by `mcp-session-id` header, then `sessionId` query param, then IP. |
| `rateLimitGlobal` | `(maxPerMinute: number) → Middleware` | Applies a single shared limit across **all** requests regardless of origin. |

---

## Core Algorithm — `checkLimit`

```
1. Retrieve or create a Bucket for the given key.
2. Filter bucket.tokens: discard timestamps older than 60 000 ms (sliding window).
3. If token count ≥ maxPerMinute:
     a. Calculate retryAfter = ceil((tokens[0] + 60_000 - now) / 1000)
     b. Set Retry-After response header.
     c. Return HTTP 429 JSON { error: { code, message, retry_after } }.
     d. Return false (middleware stops).
4. Otherwise push current timestamp, return true → call next().
```

The window slides with every request — there is no fixed epoch boundary.

---

## Key Flows

### Happy path
```
Request → middleware factory → checkLimit(key, max, res)
  → bucket pruned → count < max → timestamp appended → next()
```

### Rate-limited path
```
Request → checkLimit → count ≥ max
  → Retry-After header set → 429 JSON returned → next() NOT called
```

### Cleanup sweep (every 300 s)
```
setInterval → iterate all buckets → prune tokens older than 60 s
  → delete empty buckets from Map
```

---

## Key Design Decisions

- **Sliding window via timestamp array**: avoids fixed-window burst artifacts at window boundaries; accurate but O(n) per request proportional to bucket size.
- **Module-level `Map`**: simple, zero-latency; but state is **process-local** — incompatible with multi-process or clustered deployments without modification.
- **Dual pruning strategy**: tokens pruned eagerly on every `checkLimit` call *and* lazily by the interval sweep, balancing accuracy and memory.

---

## Edge Cases & Gotchas

- **`rateLimitGlobal` uses a single `"global"` key**: all traffic from all clients shares one counter — useful as a last-resort circuit breaker but will false-positive heavily under normal multi-user load if set too low.
- **IP resolution for `rateLimitRegister`**: falls back through `req.ip → req.socket?.remoteAddress → "unknown"`. Behind a reverse proxy without `trust proxy` configured, `req.ip` may be `127.0.0.1` for every client, collapsing all clients into one bucket.
- **`rateLimitMcp` session key priority**: session ID from header takes precedence over query param, then IP. A client that omits both falls back to IP, potentially sharing a bucket with other unauthenticated clients.
- **`setInterval` keeps the Node.js process alive**: in test environments or graceful-shutdown scenarios this may need `.unref()`.
- **No distributed state**: deploying behind a load balancer with multiple instances means each instance enforces limits independently — effective `maxPerMinute` becomes `maxPerMinute × instanceCount`.
- **`Retry-After` is computed from `tokens[0]`** (oldest token in window), giving the minimum wait; this is correct but assumes tokens are always appended in chronological order, which holds only in single-threaded Node.js.

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [setInterval Prevents Clean Exit](../knowledge/failure-modes/setinterval-prevents-clean-exit.md)
- [Memory Growth Between Sweeps](../knowledge/failure-modes/memory-growth-between-sweeps.md)
- [Unknown IP Bucket Collision](../knowledge/failure-modes/unknown-ip-bucket-collision.md)
- [Proxy IP Collapse](../knowledge/failure-modes/proxy-ip-collapse.md)
- [Global Bucket Starvation](../knowledge/failure-modes/global-bucket-starvation.md)
- [No Distributed State](../knowledge/failure-modes/no-distributed-state.md)

### has_pattern
- [Keyed Namespace Isolation](../knowledge/patterns/keyed-namespace-isolation.md)
- [Middleware Factory](../knowledge/patterns/middleware-factory.md)
- [Eager + Lazy Cleanup](../knowledge/patterns/eager-lazy-cleanup.md)
- [Sliding Window via Timestamp Array](../knowledge/patterns/sliding-window-via-timestamp-array.md)

### uses_concept
- [Sliding Window Rate Limiting](../knowledge/concepts/sliding-window-rate-limiting.md)
- [MCP Session ID](../knowledge/concepts/mcp-session-id.md)
- [rateLimitGlobal](../knowledge/concepts/ratelimitglobal.md)
- [Bucket](../knowledge/concepts/bucket.md)
- [rateLimitMcp](../knowledge/concepts/ratelimitmcp.md)
- [rateLimitRegister](../knowledge/concepts/ratelimitregister.md)
- [checkLimit](../knowledge/concepts/checklimit.md)
- [Cleanup Interval](../knowledge/concepts/cleanup-interval.md)
- [Retry-After Header](../knowledge/concepts/retry-after-header.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)

### parent_of
- [src/middleware — HTTP Security & Request Pipeline](../dirs/src--middleware.md)




