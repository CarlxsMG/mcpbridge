# CLAUDE.md — mcp-rest-bridge

## Quick Start

```bash
# Install dependencies
bun install

# Run development server
bun run src/index.ts

# Run production build
bun build src/index.ts --outdir dist

# Run tests
bun test

# Run a single test file
bun test src/__tests__/<file>.test.ts
```

---

## Pre-generated Documentation (.aico/docs)

ALWAYS read the file doc BEFORE reading source code. Documentation lives at .aico/docs/ relative to project root.
Reading order:
1. .aico/docs/overview.md — architecture, key flows, domain map.
2. .aico/docs/dirs/{path--with--dashes}.md — directory-level summary (dashes replace path separators).
3. .aico/docs/files/{path--with--dashes}.md — per-file doc (slashes replaced with --).
4. .aico/docs/knowledge/{concepts,patterns,memories,deps,failure-modes}/{slug}.md — cross-cutting knowledge.
To find the doc for any file at path P: replace / with -- and append .md, look in files/. To find a directory doc, same rule but look in dirs/.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (ESNext, strict) |
| HTTP Framework | Express 5 |
| Protocol | Model Context Protocol (MCP) SDK |
| Transport | Streamable HTTP + legacy SSE |
| Schema Validation | JSON Schema (manual + OpenAPI auto-discovery) |
| Testing | Bun test suite |
| Logging | Custom structured logger (JSON / text) |
| Build output | `./dist` via `bun build` |
| Type definitions | `bun-types` (global injection via tsconfig) |

---

## Key Rules

1. **All configuration must come from environment variables.** Never hardcode ports, timeouts, API keys, origins, or thresholds — every knob lives in `src/config.ts` backed by `process.env`.
2. **Bearer token comparison must use `timingSafeEqual`.** Direct string equality for API key validation is forbidden; see `src/middleware/auth.ts`.
3. **All outbound HTTP requests must pin to a resolved IP.** DNS-rebinding via re-resolution between lookup and request is prohibited; resolved IPs are stored on `RegisteredClient` and used in `src/proxy.ts` and `src/health.ts`.
4. **Tool names must match the strict name regex and HTTP methods must be whitelisted.** Invalid registrations are rejected synchronously in `registry.register()` before any side-effects occur.
5. **Tool `inputSchema` objects are capped at 10 KB.** Submissions exceeding this limit are rejected at registration time.
6. **Circuit breakers are per-client singletons.** Never instantiate `CircuitBreaker` directly; always go through `getCircuitBreaker(name)` in `src/circuit-breaker.ts`.
7. **Retry with exponential backoff applies to idempotent methods only.** Non-idempotent methods (e.g. POST) must not be retried automatically.
8. **`authDisabled` flag bypasses all auth checks.** It must never be set `true` in production deployments.
9. **MCP transport sessions have a TTL and a maximum count.** Exceeding either must be enforced; both limits are sourced from `config`.
10. **Admin routes require `adminAuth`; MCP routes require `mcpAuth`.** These guards must not be swapped or omitted.

---

## Patterns & Conventions

- **Singleton exports**: Stateful services (`registry`, circuit-breaker map, logger) are module-level singletons exported from their file. Consumers import the instance, not the class.
- **Dependency injection for session counts**: `src/routes/metrics.ts` uses `setSessionCountGetter()` so transport layers supply their own counters without creating a circular import.
- **Composite tool key**: Tools are indexed as `clientName__toolName` (double-underscore separator) for O(1) lookup in the `toolIndex` Map.
- **`Promise.allSettled` for fan-out**: Health checks and other batch operations use `allSettled` so a single client failure never aborts the rest of the batch.
- **Uniform MCP content envelope**: `src/proxy.ts` always returns a `{ content, isError? }` shape, keeping MCP protocol concerns isolated from HTTP concerns.
- **Request-ID stamping**: Every inbound request is stamped with a unique request ID in global middleware; all structured log entries should include it via the `meta` bag.
- **Sliding-window rate limiting**: Rate-limiter buckets store raw timestamps and prune on every check; a 5-minute `setInterval` evicts empty buckets to bound memory.
- **Background cleanup via `setInterval`**: Circuit breakers idle beyond 5 minutes and empty rate-limiter buckets are evicted by background intervals, not on-demand allocation.
- **Description sanitization before indexing**: `registry.register()` sanitizes tool descriptions before writing to the index to prevent prompt injection propagation downstream.
- **`notifyToolsChanged` as the single broadcast point**: Any mutation to the tool set (registration, unregistration, health eviction) must call `notifyToolsChanged` from `src/mcp-server.ts`; never push protocol notifications inline.
- **CORS short-circuit on OPTIONS**: Preflight requests receive HTTP 204 and `return` immediately; no downstream middleware runs.

---

## Domains

| Domain | Directory |
|---|---|
| Project Root | `.` (mcp-rest-bridge) |
| Application source | `src` |
| Unit tests | `src/__tests__` |
| Express middleware | `src/middleware` |
| Express route handlers | `src/routes` |
| Security utilities | `src/security` |

---

## Critical Files

| File | Reason |
|---|---|
| `src/config.ts` | Single source of truth for all runtime knobs; every subsystem reads it. Misconfiguration here breaks auth, rate limiting, networking, and sessions simultaneously. |
| `src/registry.ts` | Central tool and client registry; corrupting its state invalidates all MCP tool resolution and dispatch. |
| `src/logger.ts` | Shared logging utility imported by virtually every module; format or routing changes affect all observability. |
| `src/middleware/auth.ts` | Guards all admin and MCP endpoints with timing-safe Bearer validation; any regression here is a direct security breach. |
| `src/mcp-server.ts` | Wires MCP protocol handlers and owns `notifyToolsChanged`; breakage silently disconnects all LLM agents. |
| `src/middleware/rate-limiter.ts` | Sliding-window limiter protecting all three tier endpoints; memory leak or logic error affects service availability under load. |
| `src/circuit-breaker.ts` | Per-client fault-isolation gate; incorrect state transitions cascade failures to all tool calls for a client. |
| `src/routes/metrics.ts` | Admin-gated observability endpoint aggregating cross-subsystem state; requires correct `setSessionCountGetter` wiring at startup. |
| `src/health.ts` | Auto-evicts unhealthy clients and triggers tool-list broadcasts; misconfiguration silently removes valid tools from agents. |
| `src/middleware/cors.ts` | Origin allowlist enforcement; a regression allows cross-origin requests from untrusted domains. |
| `src/types.ts` | Foundational interfaces shared across all modules; a breaking change here requires coordinated updates everywhere. |
| `src/proxy.ts` | Core dispatch layer with SSRF defense, circuit-breaker gating, retry, and metrics recording; bugs here affect every tool call. |
| `src/index.ts` | Application bootstrap; controls middleware order, route mounting, and graceful shutdown — wrong ordering breaks entire request pipeline. |
| `tsconfig.json` | Compiler configuration; changing `moduleResolution` or `target` can break Bun compatibility and all type-checking guarantees. |
| `src/openapi.yaml` | Canonical API contract for registration, introspection, and both MCP transports; drives auto-discovery and Swagger UI. |

---




