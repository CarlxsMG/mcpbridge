---
id: file_fb8f23130118de80
kind: file
source_path: src/index.ts
title: "Application Entry Point — MCP REST Bridge Server"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.807Z
---

# Application Entry Point — MCP REST Bridge Server

**Path:** `src/index.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Root entry point for the MCP REST Bridge Express server. Bootstraps the full application: configures trust-proxy, wires global middleware (JSON body parsing, request-ID stamping, CORS, global rate-limiting), mounts MCP transports (Streamable HTTP + legacy SSE), registers REST route groups (register, introspection, docs, metrics), exposes a `/health` liveness endpoint, starts an internal health-check loop, and installs SIGINT/SIGTERM handlers for graceful shutdown with a 10-second force-exit fallback. All behavioural knobs are sourced from the centralised `config` module.

# `src/index.ts` — Application Entry Point

## Purpose
This is the **top-level composition root** of the MCP REST Bridge. It wires together every subsystem — middleware, transports, routes, health, and process lifecycle — into a single runnable Express server.

## Bootstrap Sequence

1. **Express app creation** — `app.set("trust proxy", config.trustProxy)`. When enabled, a `warn` log is emitted as a reminder that the server must sit behind a trusted reverse proxy to prevent IP-spoofing.
2. **Middleware stack** (applied in order):
   - `express.json()` — request body parsing
   - `requestIdMiddleware` — stamps every request with a unique ID (see [[src/middleware/request-id.ts]])
   - `corsMiddleware` — cross-origin policy (see [[src/middleware/cors.ts]])
   - `rateLimitGlobal(config.rateLimitGlobal)` — server-wide rate limiting (see [[src/middleware/rate-limiter.ts]])
3. **MCP Transports** — `setupTransports(app)` mounts Streamable HTTP and legacy SSE transport handlers, returning a `cleanupTransports` teardown function (see [[src/transports.ts]]).
4. **REST route groups**:
   - [[src/routes/register.ts]] — tool/server registration endpoints
   - [[src/routes/introspection.ts]] — schema/capability introspection
   - [[src/routes/docs.ts]] — API documentation endpoints
   - [[src/routes/metrics.ts]] — observability/metrics endpoints
5. **`/health` endpoint** — returns `{ status: "ok", uptime_seconds }` using a `startedAt` timestamp captured at module load time.
6. **Health check loop** — `startHealthCheckLoop()` runs background liveness probes against registered upstream services (see [[src/health.ts]]).
7. **`app.listen`** — binds to `config.port` and logs startup.

## Graceful Shutdown

`gracefulShutdown(signal)` is registered on both `SIGINT` and `SIGTERM`:
1. Stops the background health-check loop (`stopHealthChecks()`).
2. Tears down active MCP transport sessions (`cleanupTransports()`).
3. Closes the HTTP server; on `close` callback calls `process.exit(0)`.
4. **Force-exit fallback**: `setTimeout(() => process.exit(1), 10_000)` — if the server hasn't drained within 10 seconds, the process is killed with exit code `1`.

## Key Exports
This module has **no explicit exports** — it is a side-effectful entry point executed directly by the Node runtime.

## Gotchas
- `trust proxy` must only be enabled when the server genuinely sits behind a reverse proxy (e.g. nginx, AWS ALB); enabling it on a publicly-exposed server allows clients to spoof `X-Forwarded-For` headers, defeating IP-based rate limiting.
- The 10-second force-exit uses `process.exit(1)` (error code), which will surface as a non-zero exit in process supervisors. This is intentional — a slow shutdown indicates an unreleased resource.
- Middleware order is significant: `requestIdMiddleware` must precede anything that logs, so IDs are available in all downstream log calls.

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [IP Spoofing / Rate-Limit Bypass](../knowledge/failure-modes/ip-spoofing-rate-limit-bypass.md)
- [Port Binding Failure](../knowledge/failure-modes/port-binding-failure.md)
- [Transport Leak on Abrupt Kill](../knowledge/failure-modes/transport-leak-on-abrupt-kill.md)
- [Force-Exit with Non-Zero Code](../knowledge/failure-modes/force-exit-with-non-zero-code.md)

### has_pattern
- [Cleanup Handle Pattern](../knowledge/patterns/cleanup-handle-pattern.md)
- [Ordered Middleware Stack](../knowledge/patterns/ordered-middleware-stack.md)
- [Force-Exit Fallback](../knowledge/patterns/force-exit-fallback.md)
- [Composition Root](../knowledge/patterns/composition-root.md)

### references
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)
- [CORS Middleware — Origin Allowlist & Preflight Handler](src--middleware--cors.ts.md)
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)
- [docs.ts — Swagger UI Route Registration](src--routes--docs.ts.md)
- [Request ID Middleware](src--middleware--request-id.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Rate Limiter Middleware — Sliding Window, In-Memory](src--middleware--rate-limiter.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### uses_concept
- [Trust Proxy](../knowledge/concepts/trust-proxy.md)
- [Request ID Middleware](../knowledge/concepts/request-id-middleware.md)
- [MCP REST Bridge](../knowledge/concepts/mcp-rest-bridge.md)
- [Global Rate Limiter](../knowledge/concepts/global-rate-limiter.md)
- [MCP Transport](../knowledge/concepts/mcp-transport.md)
- [Uptime Tracking](../knowledge/concepts/uptime-tracking.md)
- [Graceful Shutdown](../knowledge/concepts/graceful-shutdown.md)
- [Composition Root](../knowledge/concepts/composition-root.md)
- [Health Check Loop](../knowledge/concepts/health-check-loop.md)

## Backlinks

### references
- [Dockerfile — Multi-Stage Bun/Alpine Production Container](Dockerfile.md)
- [package.json — mcp-rest-bridge Project Manifest](package.json.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




