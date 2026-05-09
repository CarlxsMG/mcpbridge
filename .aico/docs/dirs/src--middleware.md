---
id: dir_5fa7f767a4f0337a
kind: dir
source_path: src/middleware
title: "src/middleware — HTTP Security & Request Pipeline"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.611Z
---

# src/middleware — HTTP Security & Request Pipeline

**Path:** `src/middleware`  
**Kind:** `dir`  
**Model:** `sonnet`

> The `src/middleware` directory implements the full HTTP security and request-lifecycle pipeline for an Express server with MCP transport integration. Five focused middleware modules compose the layer: `cors.ts` sets CORS response headers from a runtime allowlist and short-circuits preflight OPTIONS; `origin-validator.ts` enforces an origin allowlist with browser/server-to-server discrimination via `Sec-Fetch-Site`; `request-id.ts` propagates or mints a UUID-based `X-Request-ID` for distributed tracing; `rate-limiter.ts` provides sliding-window IP/session/global rate limiting backed by an in-memory Map with periodic cleanup; and `auth.ts` guards admin and MCP routes via timing-safe Bearer-token validation with a global bypass flag for legacy deployments.

# src/middleware — HTTP Security & Request Pipeline

## Overview

This directory contains all Express middleware responsible for securing, identifying, and throttling HTTP requests before they reach route handlers. The modules are designed to be composed in sequence and collectively cover authentication, authorization, rate control, request correlation, and cross-origin policy enforcement — with explicit support for the MCP (Model Context Protocol) server transport layer.

---

## Modules

### `cors.ts` — CORS Header Enforcement
- Reads allowed origins from `config.corsOrigins` at request time.
- Injects `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` only for matching origins.
- Short-circuits `OPTIONS` preflight requests with **HTTP 204**, preventing further middleware execution.
- Exposes `mcp-session-id` as an allowed header, indicating tight coupling with the MCP transport layer.
- Non-preflight requests always proceed to `next()` regardless of CORS match.

### `origin-validator.ts` — Origin Allowlist Validation
- Distinguishes browser-originated requests from server-to-server calls using the `Sec-Fetch-Site` header.
- Server-to-server requests without an `Origin` header are unconditionally forwarded.
- Browser requests without an `Origin` header are rejected with **HTTP 403**.
- Matched against `config.allowedOrigins`, which supports:
  - Exact string matches
  - Global wildcard (`*`)
  - Wildcard-port patterns (e.g., `http://host:*`)
- Returns a structured JSON 403 on rejection; calls `next()` on success.

### `request-id.ts` — Distributed Request Correlation
- Reads the incoming `X-Request-ID` header to honour caller-supplied IDs for tracing continuity.
- Falls back to `crypto.randomUUID()` (Node built-in) when no ID is present.
- Stores the resolved ID on `res.locals.requestId` for downstream handlers.
- Mirrors the ID back to the client via the `X-Request-ID` response header.
- Zero external dependencies; enables consistent log/error/response correlation across services.

### `rate-limiter.ts` — Sliding-Window Rate Limiting
- Uses an in-memory `Map` where each bucket holds an array of request timestamps.
- Entries older than **60 seconds** are pruned on every request check (sliding window).
- A `setInterval` sweep runs every **5 minutes** to evict empty buckets and bound memory growth.
- Exports three middleware factories:
  | Factory | Bucket Key |
  |---|---|
  | `rateLimitRegister` | Client IP |
  | `rateLimitMcp` | MCP session ID, falls back to IP |
  | `rateLimitGlobal` | Single shared key |
- Exceeded limits respond with **HTTP 429**, a `Retry-After` header, and a structured JSON error.

### `auth.ts` — Authentication Guards
- Provides two middleware guards: `adminAuth` (admin API routes) and `mcpAuth` (MCP endpoints).
- Both extract Bearer tokens from the `Authorization` header.
- Validates tokens using **`timingSafeEqual`** to eliminate timing-based side-channel attacks.
- A global `authDisabled` config flag bypasses all authentication checks.
- `mcpAuth` additionally permits all traffic when **no MCP keys are configured**, maintaining backward compatibility with pre-key deployments.

---

## Composition & Design Patterns

| Concern | Module | Mechanism |
|---|---|---|
| Cross-origin policy | `cors.ts` | Runtime config allowlist + preflight short-circuit |
| Origin enforcement | `origin-validator.ts` | `Sec-Fetch-Site` heuristic + pattern matching |
| Request tracing | `request-id.ts` | UUID propagation via headers + `res.locals` |
| Abuse prevention | `rate-limiter.ts` | Sliding-window Map, session/IP/global keying |
| Access control | `auth.ts` | Timing-safe Bearer token comparison |

- **Defense-in-depth**: Origin validation, CORS, and auth are independent layers; no single bypass defeats all checks.
- **MCP awareness**: `cors.ts` (exposed `mcp-session-id` header) and `rate-limiter.ts` (`rateLimitMcp` session keying) are explicitly MCP-aware.
- **Backward compatibility**: `auth.ts` preserves open-access behaviour when MCP keys are absent, easing migration.
- **Memory safety**: `rate-limiter.ts` uses periodic cleanup to prevent unbounded Map growth under sustained traffic.
## Domains

- `express`
- `http-security`
- `middleware`
- `cors`
- `authentication`
- `rate-limiting`
- `distributed-tracing`
- `mcp`


---

## Backlinks

### child_of
- [CORS Middleware — Origin Allowlist & Preflight Handler](../files/src--middleware--cors.ts.md)
- [Origin Validator Middleware](../files/src--middleware--origin-validator.ts.md)
- [Request ID Middleware](../files/src--middleware--request-id.ts.md)
- [Rate Limiter Middleware — Sliding Window, In-Memory](../files/src--middleware--rate-limiter.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](../files/src--middleware--auth.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](src.md)




