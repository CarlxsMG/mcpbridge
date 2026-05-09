---
id: file_09572a7cd35c8bb9
kind: file
source_path: src/transports.ts
title: "MCP Transport Setup — Streamable HTTP & Legacy SSE"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.774Z
---

# MCP Transport Setup — Streamable HTTP & Legacy SSE

**Path:** `src/transports.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Registers all MCP transport endpoints on an Express app and manages their session lifecycles. Provides two transports: a primary Streamable HTTP transport on `/mcp` (POST/GET/DELETE) and a legacy SSE fallback on `/sse` + `/messages`. Maintains in-memory session Maps with TTL-based cleanup, enforces a global max-sessions cap (503 on overflow), runs an SSE heartbeat every 15 s, and returns a teardown function for graceful shutdown. All endpoints are guarded by origin validation, authentication, and per-IP rate limiting middleware.

# `src/transports.ts`

## Purpose

Bootstraps the full MCP server transport layer onto an Express application. It owns session lifecycle — creation, activity tracking, TTL expiry, and teardown — for both the modern **Streamable HTTP** and the legacy **SSE** transports defined by the MCP specification.

---

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `setupTransports(app)` | function | Attaches all route handlers to `app`, starts the cleanup loop, and returns a `() => void` teardown callback. |

---

## Key Flows

### 1. Streamable HTTP (`/mcp`)

All three HTTP verbs share the same path and are protected by `originValidator → mcpAuth → rateLimitMcp`.

**POST /mcp — session routing logic:**

```
Has mcp-session-id header?
  ├─ YES, session exists  → reuse transport, touchSession
  ├─ YES, session missing → 404 "Session not found or expired"
  └─ NO (initialize)
       ├─ totalSessions >= maxSessions → 503 capacity error
       └─ create StreamableHTTPServerTransport
            → connect new MCP server
            → handleRequest (sets transport.sessionId internally)
            → store in streamableSessions, touchSession
```

**GET /mcp** — opens the SSE stream for server-to-client pushes; sets `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` to prevent proxy buffering.

**DELETE /mcp** — signals session teardown; delegates to `transport.handleRequest` then removes the session from the map.

### 2. Legacy SSE (`/sse` + `/messages`)

- **GET /sse**: creates an `SSEServerTransport`, enforces the same capacity cap, emits a `:heartbeat` SSE comment every **15 s** (keeps proxies alive), and cleans up on `req.close`.
- **POST /messages**: routes the JSON-RPC body to the session identified by `?sessionId=` query param via `transport.handlePostMessage`.

### 3. Session TTL Cleanup

`startSessionCleanup()` runs `setInterval` every **60 s**. Any session whose last `touchSession` timestamp is older than `config.sessionTtlMs` is closed and removed from all three maps (`streamableSessions`, `sseSessions`, `sessionActivity`).

### 4. Metrics Integration

`setSessionCountGetter` is called immediately so the `/metrics` route can report live counts for both transport types without importing the Maps directly.

### 5. Graceful Shutdown

`setupTransports` returns a cleanup closure that:
1. Clears the TTL `setInterval`.
2. Iterates both session Maps, calls `.close()` on each transport (errors swallowed), and empties the Maps.

---

## Edge Cases & Gotchas

- **`transport.sessionId` is only available after `handleRequest`** on a new streamable session — the Map insertion must happen *after* the first `handleRequest` call, not before.
- **`transport.onclose` scans the entire Map** by value identity to find the session ID, since the ID is not captured in the closure at assignment time.
- **SSE `server` is hoisted** (`let server`) so both the heartbeat error handler and `req.on("close")` can call `server?.close()` before the `await server.connect(transport)` line completes (race-safe via optional chaining).
- `res.flushHeaders()` is called before `server.connect` to ensure the SSE `200 OK` response reaches the client before any MCP handshake messages.
- All `transport.close()` / `server.close()` calls are wrapped in `try/catch {}` to prevent cleanup cascades from surfacing errors during shutdown.
- The `cleanupTimer` is module-level; calling `setupTransports` more than once would leak a timer — intended as a singleton.

---

## Middleware Chain

```
/mcp   →  originValidator  →  mcpAuth  →  rateLimitMcp
/sse   →  originValidator  →  mcpAuth  →  rateLimitMcp  (inline)
/messages → same inline chain
```

See [[src/middleware/origin-validator.ts]], [[src/middleware/auth.ts]], [[src/middleware/rate-limiter.ts]].

---

## References

### has_dep
- [npm:@modelcontextprotocol/sdk](../knowledge/deps/npm-modelcontextprotocol-sdk.md)
- [npm:express](../knowledge/deps/npm-express.md)
- [npm:crypto](../knowledge/deps/npm-crypto.md)

### has_failure_mode
- [Capacity Bypass Under Concurrent Requests](../knowledge/failure-modes/capacity-bypass-under-concurrent-requests.md)
- [Cleanup Timer Leak on Multiple Calls](../knowledge/failure-modes/cleanup-timer-leak-on-multiple-calls.md)
- [SSE Heartbeat Race on Fast Disconnect](../knowledge/failure-modes/sse-heartbeat-race-on-fast-disconnect.md)
- [Session Not Persisted on Initialize](../knowledge/failure-modes/session-not-persisted-on-initialize.md)
- [Proxy Buffering on SSE GET /mcp](../knowledge/failure-modes/proxy-buffering-on-sse-get-mcp.md)
- [Stale onclose Scan](../knowledge/failure-modes/stale-onclose-scan.md)

### has_pattern
- [Dual Transport Fallback](../knowledge/patterns/dual-transport-fallback.md)
- [Swallowed Cleanup Errors](../knowledge/patterns/swallowed-cleanup-errors.md)
- [Session Registry with TTL Eviction](../knowledge/patterns/session-registry-with-ttl-eviction.md)
- [Deferred Map Insertion](../knowledge/patterns/deferred-map-insertion.md)
- [Returned Teardown Closure](../knowledge/patterns/returned-teardown-closure.md)

### references
- [Origin Validator Middleware](src--middleware--origin-validator.ts.md)
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)
- [Rate Limiter Middleware — Sliding Window, In-Memory](src--middleware--rate-limiter.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)

### uses_concept
- [Session Map](../knowledge/concepts/session-map.md)
- [SSE Transport](../knowledge/concepts/sse-transport.md)
- [SSE Heartbeat](../knowledge/concepts/sse-heartbeat.md)
- [Origin Validator](../knowledge/concepts/origin-validator.md)
- [Streamable HTTP Transport](../knowledge/concepts/streamable-http-transport.md)
- [Session TTL Cleanup](../knowledge/concepts/session-ttl-cleanup.md)
- [Graceful Shutdown](../knowledge/concepts/graceful-shutdown.md)
- [MCP Session Initialization](../knowledge/concepts/mcp-session-initialization.md)
- [Max Sessions Cap](../knowledge/concepts/max-sessions-cap.md)
- [Session Count Getter](../knowledge/concepts/session-count-getter.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




