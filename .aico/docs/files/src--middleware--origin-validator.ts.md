---
id: file_2c48a00e80b667ad
kind: file
source_path: src/middleware/origin-validator.ts
title: "Origin Validator Middleware"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.781Z
---

# Origin Validator Middleware

**Path:** `src/middleware/origin-validator.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Express middleware that enforces an origin allowlist for incoming HTTP requests. Distinguishes browser requests from server-to-server calls using the `Sec-Fetch-Site` header: server-to-server requests lacking an `Origin` header are passed through unconditionally, while browser requests without one are rejected with 403. For requests carrying an `Origin` header, the value is matched against `config.allowedOrigins` patterns supporting exact strings, a global wildcard (`*`), and wildcard-port patterns (`http://host:*`). Returns 403 JSON on rejection, calls `next()` on success.

# Origin Validator Middleware

**File:** `src/middleware/origin-validator.ts`

## Purpose

Provides Express middleware that gates HTTP requests by validating their `Origin` header against a configurable allowlist. Implements a nuanced bypass for server-to-server (non-browser) traffic using the browser-injected `Sec-Fetch-Site` header as a signal.

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `originValidator` | Express middleware | Main guard function; attach to routes or globally |
| `matchOrigin` (unexported) | Helper | Pattern matching logic for a single origin vs. a single pattern |

## Key Flows

### 1. No `Origin` header present
- **Browser request** (detected by `Sec-Fetch-Site` header being present): rejected → `403 { error: "Origin header required for browser requests" }`.
- **Server-to-server request** (no `Sec-Fetch-Site`): allowed → `next()`.

### 2. `Origin` header present
- Iterates `config.allowedOrigins` patterns via `matchOrigin`.
- On first match: allowed → `next()`.
- No match: rejected → `403 { error: "Origin not allowed" }`.

## Pattern Matching (`matchOrigin`)

| Pattern form | Example | Behavior |
|---|---|---|
| `"*"` | `"*"` | Unconditionally allows any origin |
| Wildcard port | `"http://localhost:*"` | `origin.startsWith("http://localhost:")` |
| Exact string | `"https://app.example.com"` | Strict equality |

> **Gotcha:** Wildcard port matching strips only the trailing `*`, keeping the colon, so the prefix tested is `"http://localhost:"`. Any port (including none) satisfies the check as long as the scheme+host prefix matches.

## Edge Cases & Gotchas

- **`Sec-Fetch-Site` as browser signal**: This header is browser-injected and not forged by typical HTTP clients, making it a reasonable (though not cryptographically secure) heuristic.
- **`*` in `allowedOrigins`**: A single `"*"` entry disables origin enforcement for all requests with an `Origin` header — use only in development.
- **HTTPS vs HTTP**: Pattern matching is case-sensitive and scheme-sensitive; `"https://..."` will not match `"http://..."`.
- **No port normalization**: Origins with default ports (e.g., `:443`) are not normalized before comparison; patterns must match exactly what browsers send.
- **`config.allowedOrigins` is read at call time**, not at module init, so runtime config changes take effect immediately.

## Dependencies

- [[src/config.ts]] — provides `config.allowedOrigins: string[]`
- Express types: `Request`, `Response`, `NextFunction`

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Case-Sensitive Scheme Mismatch](../knowledge/failure-modes/case-sensitive-scheme-mismatch.md)
- [Forged Sec-Fetch-Site](../knowledge/failure-modes/forged-sec-fetch-site.md)
- [Browser Request Without Origin Blocked](../knowledge/failure-modes/browser-request-without-origin-blocked.md)
- [Global Wildcard Disables Guard](../knowledge/failure-modes/global-wildcard-disables-guard.md)
- [Wildcard Port Over-Matches](../knowledge/failure-modes/wildcard-port-over-matches.md)

### has_pattern
- [Allowlist with Pattern Hierarchy](../knowledge/patterns/allowlist-with-pattern-hierarchy.md)
- [Early-Return Guard Middleware](../knowledge/patterns/early-return-guard-middleware.md)
- [Fetch Metadata Browser Detection](../knowledge/patterns/fetch-metadata-browser-detection.md)

### references
- [Application Configuration Module (src/config.ts)](src--config.ts.md)

### uses_concept
- [Sec-Fetch-Site Header](../knowledge/concepts/sec-fetch-site-header.md)
- [Server-to-Server Bypass](../knowledge/concepts/server-to-server-bypass.md)
- [Origin Validation](../knowledge/concepts/origin-validation.md)
- [Origin Allowlist](../knowledge/concepts/origin-allowlist.md)
- [Wildcard Port Pattern](../knowledge/concepts/wildcard-port-pattern.md)

## Backlinks

### references
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)

### parent_of
- [src/middleware — HTTP Security & Request Pipeline](../dirs/src--middleware.md)




