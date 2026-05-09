---
id: file_0f345a5428776a9d
kind: file
source_path: src/middleware/cors.ts
title: "CORS Middleware — Origin Allowlist & Preflight Handler"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.776Z
---

# CORS Middleware — Origin Allowlist & Preflight Handler

**Path:** `src/middleware/cors.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Express middleware that enforces a per-origin CORS allowlist sourced from runtime config. For each inbound request, it compares `req.headers.origin` against `config.corsOrigins`; only matching origins receive the three CORS response headers (`Allow-Origin`, `Allow-Methods`, `Allow-Headers`). Preflight `OPTIONS` requests are short-circuited with HTTP 204 and no further middleware runs. Non-preflight requests always advance to `next()`, regardless of whether CORS headers were set. Exposed allowed headers include `mcp-session-id`, indicating integration with an MCP server transport layer.

# `src/middleware/cors.ts`

## Purpose
Provides a lightweight, custom CORS middleware for an Express application. Rather than using the third-party `cors` package, this implementation manually validates the request `Origin` header against a runtime-configured allowlist and sets the appropriate response headers only for recognised origins.

## Exports

### `corsMiddleware(req, res, next): void`
Standard Express `RequestHandler`. Intended to be registered early in the middleware chain (before route handlers).

## Key Flow

```
Incoming request
  └─ Has Origin header?
       ├─ YES → Is origin in config.corsOrigins?
       │           ├─ YES → Set Access-Control-Allow-Origin (echo origin)
       │           │         Set Access-Control-Allow-Methods
       │           │         Set Access-Control-Allow-Headers
       │           └─ NO  → No CORS headers added
       └─ NO  → Skip header block
  └─ Method === OPTIONS?
       ├─ YES → res.sendStatus(204) + return  (preflight complete)
       └─ NO  → next()
```

## Allowed Values

| Header | Value |
|---|---|
| `Access-Control-Allow-Methods` | `GET, POST, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, mcp-session-id` |

The presence of `mcp-session-id` signals that this server participates in the [[Model Context Protocol (MCP)]] transport, where session continuity is tracked via a custom header.

## Edge Cases & Gotchas

- **No wildcard fallback** — origins not listed in [[config.corsOrigins]] receive zero CORS headers; browsers will block such cross-origin responses silently.
- **`Access-Control-Allow-Credentials` is absent** — cookies/credentials cannot be forwarded even for allowed origins.
- **`OPTIONS` always returns 204**, even when the origin is *not* in the allowlist. The preflight short-circuit fires after the header-setting block, so an unlisted origin's preflight still gets a 204 with no CORS headers — browsers interpret this as a failed preflight and block the actual request, which is the desired behaviour, but the 204 could be misleading in logs.
- **Origin cast** — `req.headers.origin` is cast to `string | undefined`; the `Array.includes` call is safe because the guard `if (origin && ...)` filters `undefined` first.
- **No `Vary: Origin` header** — caching proxies may incorrectly serve a cached response with the wrong (or absent) `Allow-Origin` header to a different origin.

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [OPTIONS 204 for Disallowed Origin](../knowledge/failure-modes/options-204-for-disallowed-origin.md)
- [Credentials Not Supported](../knowledge/failure-modes/credentials-not-supported.md)
- [Unlisted Origin Silent Block](../knowledge/failure-modes/unlisted-origin-silent-block.md)
- [Missing Vary Header](../knowledge/failure-modes/missing-vary-header.md)

### has_pattern
- [Preflight Short-Circuit](../knowledge/patterns/preflight-short-circuit.md)
- [Origin Allowlist (Explicit Whitelist)](../knowledge/patterns/origin-allowlist-explicit-whitelist.md)
- [Config-Driven Policy](../knowledge/patterns/config-driven-policy.md)

### references
- [Model Context Protocol (MCP)](../knowledge/concepts/model-context-protocol-mcp.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)

### uses_concept
- [CORS Allowlist](../knowledge/concepts/cors-allowlist.md)
- [mcp-session-id](../knowledge/concepts/mcp-session-id.md)
- [Preflight Request](../knowledge/concepts/preflight-request.md)
- [Origin Echo Pattern](../knowledge/concepts/origin-echo-pattern.md)
- [Express RequestHandler](../knowledge/concepts/express-requesthandler.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)

### parent_of
- [src/middleware — HTTP Security & Request Pipeline](../dirs/src--middleware.md)




