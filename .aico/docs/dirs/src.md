---
id: dir_3627e9e02e3c9833
kind: dir
source_path: src
title: "src — MCP REST Bridge: Full Application Root"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.611Z
---

# src — MCP REST Bridge: Full Application Root

**Path:** `src`  
**Kind:** `dir`  
**Model:** `sonnet`

> The `src` directory is a production MCP REST Bridge — an Express server translating Model Context Protocol tool calls into backend REST requests. Subsystems include: a dual-transport layer (Streamable HTTP + legacy SSE) with TTL session management; a singleton Registry for tool registration (manual or OpenAPI auto-discovery); a circuit-breaking proxy with exponential-backoff retry and DNS-pinned IP resolution; and a health-check loop with auto-eviction. Security spans SSRF defenses, origin validation, timing-safe Bearer auth, sliding-window rate limiting, CORS, and prompt-injection sanitization. Structured logging, request-ID tracing, Swagger UI, and a metrics endpoint provide observability. All configuration is environment-driven.

# src — MCP REST Bridge: Full Application Root

## Purpose
`src` is the root of a production Express server that bridges the **Model Context Protocol (MCP)** to arbitrary backend REST APIs. It aggregates all application layers — transport, proxy, registry, security, observability — into a cohesive gateway.

## Architecture Overview

### Entry & Bootstrap (`index.ts`, `config.ts`)
- `index.ts` bootstraps the full stack: trust-proxy config, global middleware, transport mounting, route registration, health-loop startup, and graceful SIGINT/SIGTERM shutdown with a 10-second force-exit fallback.
- `config.ts` exports a single environment-driven `config` object governing every behavioral knob: ports, timeouts, session limits, auth keys, rate-limit tiers, CORS, and failure thresholds.

### Transport Layer (`transports.ts`)
- Mounts two MCP transports on Express: **Streamable HTTP** (`POST/GET/DELETE /mcp`) and a **legacy SSE fallback** (`GET /sse` + `POST /messages`).
- Maintains in-memory session `Map`s with TTL cleanup and a global max-sessions cap (503 on overflow).
- Runs an SSE heartbeat every 15 s; returns a teardown function for graceful shutdown.

### MCP Server (`mcp-server.ts`)
- `createMcpServer` instantiates named MCP server instances with `tools/list_changed` capability, wiring `ListTools` and `CallTool` handlers.
- `notifyToolsChanged` broadcasts change notifications to all live servers via a module-level `activeServers` Set.

### Registry (`registry.ts`, `types.ts`)
- Singleton `Registry` class with O(1) tool resolution via two Maps: `clients` and a composite-key `toolIndex` (`clientName__toolName`).
- Strict registration validation: name regex, HTTP method whitelist, `inputSchema` type/size (10 KB cap), duplicate detection.
- Supports lookup, listing, unregistration, and health-status mutation.
- `types.ts` defines the four shared interfaces: `RegistrationPayload`, `RestToolDefinition`, `RegisteredClient`, `ResolvedTool`.

### Proxy Layer (`proxy.ts`)
- Resolves tool names via the registry, validates args against JSON Schema, substitutes URL path parameters.
- Pins requests to resolved IPs to prevent DNS rebinding.
- Applies circuit-breaker gating, exponential-backoff retry (idempotent methods only), and `Retry-After` header respect for 429s.
- Per-client `AbortController` tracking enables cancellation; uniform MCP content envelope returned with optional `isError`.

### Circuit Breaker (`circuit-breaker.ts`)
- Per-client three-state machine: `closed` → `open` → `half_open` → `closed`.
- Lazy singleton creation via `getCircuitBreaker`; background `setInterval` evicts breakers idle beyond 5 minutes.

### Health Checks (`health.ts`)
- Polls all registered clients in batches of 20 (`Promise.allSettled`) against pinned IPs.
- Consecutive failure counter drives state: `FAILURE_THRESHOLD` (3) → `unreachable`; `maxConsecutiveFailures` → auto-eviction.
- Status transitions and evictions trigger `notifyToolsChanged`.

### OpenAPI Discovery (`openapi-discovery.ts`)
- Fetches, parses, and dereferences OpenAPI 3.x specs (JSON or YAML); enforces 5 MB size cap.
- Filters by tag inclusion / operationId exclusion; skips `x-internal` operations.
- Converts OpenAPI path templates to Express-style params; merges path + operation parameters with request body into a flat JSON Schema.

### Security (`security/`, `sanitize.ts`, `middleware/`)
- **SSRF**: uint32 CIDR bitmask matching for private IPv4 ranges; string-prefix heuristics for IPv6; protocol enforcement (HTTP/HTTPS only); optional host allowlist; DNS screening with IP pinning.
- **Prompt injection**: `sanitizeToolDescription` applies Unicode normalization, regex-based injection-phrase removal, and markdown stripping; hard-truncates at 500 chars; logs mutations.
- **Middleware stack**: CORS headers from runtime allowlist; origin validation with `Sec-Fetch-Site` discrimination; UUID-based `X-Request-ID` propagation; sliding-window rate limiting (register / MCP / global tiers); timing-safe Bearer-token auth with global bypass flag.

### Routes (`routes/`)
- `register.ts`: manual tool array or OpenAPI URL ingestion with SSRF validation, IP pinning, and `toolsChanged` broadcast.
- `introspection.ts`: admin-authenticated client listing, tool manifest inspection, and graceful teardown with circuit-breaker cleanup.
- `metrics.ts`: call counts, rolling latency averages, session counts (injected via getter), per-client circuit breaker states.
- `docs.ts`: Swagger UI from eagerly loaded `openapi.yaml`.

### Observability (`logger.ts`)
- Thin structured logger: JSON (newline-delimited) or human-readable (ISO-timestamp + level) based on `config.logFormat`.
- Three severity levels (info, warn, error); optional `meta` key-value bag; errors routed to `console.error`.

### API Specification (`openapi.yaml`)
- OpenAPI 3.1.0 spec defining all paths: `/register`, `/clients`, `/metrics`, `/health`, `/mcp`, `/sse`, `/messages`.
- Declares `AdminAuth` and `McpAuth` bearer schemes; full schema coverage for `RegisterClientRequest`, `RestToolDefinition`, `RegisteredClient`, `ApiError`, `JsonRpcMessage`.

### Tests (`__tests__/`)
- Bun unit suite with hermetic `beforeEach` state resets.
- Four modules: `sanitize.test.ts`, `circuit-breaker.test.ts` (with `Date.now` override), `auth.test.ts` (live ESM mutation), `registry.test.ts`.

## Key Design Properties
| Property | Mechanism |
|---|---|
| DNS rebinding prevention | IP pinning at registration + health + proxy layers |
| Fault isolation | Circuit breaker per client; health-loop auto-eviction |
| Dynamic tool surface | Registry + OpenAPI discovery + `tools/list_changed` notifications |
| Prompt injection defense | Unicode normalization, phrase removal, hard truncation |
| Observability | Request IDs, structured logs, `/metrics`, `/health` |
| Configuration | Single `config` object; 100% environment-variable driven |
## Domains

- `api-gateway`
- `mcp`
- `security`
- `networking`
- `observability`
- `rest`
- `express`
- `circuit-breaker`
- `openapi`
- `typescript`


---

## Backlinks

### child_of
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](../files/src--transports.ts.md)
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](../files/src--proxy.ts.md)
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](../files/src--health.ts.md)
- [MCP Server Factory & Tool-Change Notifier](../files/src--mcp-server.ts.md)
- [Application Configuration Module (src/config.ts)](../files/src--config.ts.md)
- [src/types.ts — Core Domain Interfaces](../files/src--types.ts.md)
- [Logger — Structured Dual-Format Log Emitter](../files/src--logger.ts.md)
- [sanitize.ts — Tool Description Sanitization & Prompt Injection Defense](../files/src--sanitize.ts.md)
- [OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs](../files/src--openapi-discovery.ts.md)
- [Circuit Breaker — Per-Client Fault Isolation with Idle Eviction](../files/src--circuit-breaker.ts.md)
- [src/openapi.yaml — MCP REST Bridge OpenAPI 3.1 spec](../files/src--openapi.yaml.md)
- [Registry — MCP Client & Tool Registration Manager](../files/src--registry.ts.md)
- [Application Entry Point — MCP REST Bridge Server](../files/src--index.ts.md)

### parent_of
- mcp-rest-bridge — Project Root




