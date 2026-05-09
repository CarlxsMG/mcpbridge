---
id: overview_c1d8e334c349e67b
kind: overview
source_path: overview
title: "mcp-rest-bridge — REST-to-MCP Gateway"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.808Z
---

# mcp-rest-bridge — REST-to-MCP Gateway

**Path:** `overview`  
**Kind:** `overview`  
**Model:** `sonnet`

> `mcp-rest-bridge` is a Bun/TypeScript service bridging REST APIs to MCP tool surfaces for LLM agents. Express 5 hosts dual transports (Streamable HTTP + legacy SSE) with TTL session management and a Registry for manual or OpenAPI-driven tool registration. A circuit-breaking proxy with exponential-backoff retry and DNS-pinned SSRF defenses handles outbound calls. Security covers timing-safe Bearer auth, sliding-window rate limiting, origin validation, CORS, and prompt-injection sanitization. An admin plane provides CRUD over proxy clients and circuit-breaker state. Structured logging, request-ID tracing, Swagger UI, and `/metrics` deliver full observability. Entirely environment-driven; a Bun unit-test suite validates all subsystems.

# mcp-rest-bridge — REST-to-MCP Gateway

## Purpose

`mcp-rest-bridge` translates Model Context Protocol (MCP) tool calls into backend REST requests, making arbitrary HTTP APIs consumable by LLM agents as structured, schema-validated tool surfaces. It ships as a multi-stage Alpine Docker image running unprivileged on port 3000, fully configured through environment variables.

---

## Architecture

### Transport & Session Layer (`src/`)

- **Dual MCP transports**: Streamable HTTP (primary) and legacy SSE, each with TTL-based session management and a health-check loop with auto-eviction of stale sessions.
- **Tool Registry**: A singleton supporting manual tool arrays and OpenAPI URL-based auto-discovery via `@scalar/openapi-parser`. Enforces name validation, a 10 KB schema cap, composite-key resolution, and overwrite semantics.
- **Proxy Engine**: A three-state circuit breaker (closed → open → half-open), exponential-backoff retry, and DNS-pinned outbound connection targeting to partially mitigate DNS rebinding.

---

### HTTP Middleware Pipeline (`src/middleware/`)

| Module | Responsibility |
|---|---|
| `cors.ts` | Runtime allowlist-based CORS headers + OPTIONS preflight short-circuit |
| `origin-validator.ts` | Origin allowlist enforcement with `Sec-Fetch-Site`-aware browser/server discrimination |
| `request-id.ts` | Propagates or mints UUID-based `X-Request-ID` for distributed tracing |
| `rate-limiter.ts` | Sliding-window IP/session/global rate limiting via in-memory Map with periodic cleanup |
| `auth.ts` | Timing-safe Bearer-token validation; global `AUTH_DISABLED` bypass flag for legacy MCP deployments |

---

### Route Plane (`src/routes/`)

| Route | Purpose |
|---|---|
| `/docs` | Swagger UI served from an eagerly loaded OpenAPI spec |
| `/register` | Dynamic tool registration (manual array or OpenAPI URL ingestion); SSRF-validated; broadcasts `toolsChanged` to live MCP clients |
| `/introspect` | Admin-authenticated CRUD over proxy clients — listing, tool manifest inspection, graceful teardown with circuit-breaker cleanup |
| `/metrics` | Aggregated telemetry: call counts, rolling latency averages, session counts (injected via getter), per-client circuit-breaker states |

---

### SSRF Defenses (`src/security/`)

Outbound URL validation applies multi-layer blocking before any request leaves the service:

- **IPv4**: loopback, RFC-1918, link-local, APIPA — matched via uint32 CIDR bitmask arithmetic.
- **IPv6**: loopback (`::1`), ULA (`fc`/`fd` prefixes), link-local (`fe80`–`feb`) — matched via string-prefix heuristics.
- **Protocol enforcement**: HTTP and HTTPS only; all other schemes are rejected immediately.
- **DNS rebinding mitigation**: every hostname is resolved via Bun's runtime DNS API; the first resolved IP is pinned as the connection target. Raw IP literals bypass DNS and are validated directly.
- **Optional host allowlist**: explicit access-control list for approved backend hosts.

Any private-range hit causes immediate rejection before a connection is attempted.

---

### Test Suite (`src/__tests__/`)

Hermetic Bun unit tests across four modules, all resetting shared state in `beforeEach` for full isolation:

| File | Coverage |
|---|---|
| `sanitize.test.ts` | Prompt-injection stripping, passthrough, 500-char truncation, degenerate inputs |
| `circuit-breaker.test.ts` | Three-state machine transitions with `Date.now` override for time simulation; per-test registry isolation |
| `auth.test.ts` | Live ESM object mutation for Express middleware testing; Bearer validation, `AUTH_DISABLED` bypass, MCP backward-compatibility |
| `registry.test.ts` | Registration lifecycle, name validation, 10 KB schema cap, composite-key resolution, overwrite semantics, unregistration cleanup |

---

## Deployment

- **Runtime**: Bun on a multi-stage Alpine Docker image; application runs as an unprivileged user.
- **Port**: 3000 (default).
- **Configuration**: Entirely environment-driven — auth tokens, allowed origins, rate-limit thresholds, circuit-breaker parameters, and SSRF allowlists are all set via env vars.
- **Observability**: Structured JSON logging, `X-Request-ID` tracing propagated through all layers, Swagger UI at `/docs`, and telemetry at `/metrics`.
## Domains

### root

Project root and Docker packaging. Multi-stage Alpine image runs Express 5 on Bun unprivileged on port 3000. Declares all top-level dependencies and the environment-driven configuration surface for the entire service.

### src

Application entry point and core runtime. Wires dual MCP transports (Streamable HTTP + legacy SSE) with TTL session management, the singleton tool Registry, a circuit-breaking proxy with exponential-backoff retry, and a health-check eviction loop into a single Express server.

### src/__tests__

Hermetic Bun unit test suite. Four modules validate prompt-injection sanitization, circuit-breaker state-machine transitions (with Date.now override), Express auth middleware (via live ESM mutation), and Registry lifecycle — all with beforeEach shared-state resets.

### src/middleware

HTTP security and request-lifecycle pipeline. Five focused modules: CORS header injection, origin-allowlist validation with Sec-Fetch-Site discrimination, UUID request-ID propagation, sliding-window IP/session/global rate limiting, and timing-safe Bearer-token auth with a global legacy-bypass flag.

### src/routes

Express route handlers forming the control, registration, documentation, and observability plane. Covers Swagger UI (/docs), dynamic tool registration with SSRF validation and toolsChanged broadcast (/register), admin CRUD over proxy clients (/introspect), and aggregated telemetry (/metrics).

### src/security

SSRF defense layer for outbound backend URL validation. Blocks private IPv4 ranges via uint32 CIDR bitmask matching and IPv6 ranges via prefix heuristics. Enforces HTTP/HTTPS-only protocols, resolves hostnames via Bun DNS with first-IP pinning to mitigate rebinding, and supports an explicit host allowlist.




