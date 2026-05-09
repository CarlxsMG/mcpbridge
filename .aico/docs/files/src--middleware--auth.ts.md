---
id: file_d120245e52b4470d
kind: file
source_path: src/middleware/auth.ts
title: "Express Bearer Token Auth Middleware (Admin & MCP)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.802Z
---

# Express Bearer Token Auth Middleware (Admin & MCP)

**Path:** `src/middleware/auth.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Authentication middleware for Express providing two guards: `adminAuth` for admin API routes and `mcpAuth` for MCP endpoints. Both extract Bearer tokens from the `Authorization` header and validate against configured API key lists using constant-time comparison (`timingSafeEqual`) to prevent timing attacks. A global `authDisabled` config flag bypasses all checks. `mcpAuth` additionally permits all traffic when no MCP keys are configured, preserving backward compatibility with deployments that predate key-based MCP auth.

# `src/middleware/auth.ts`

## Purpose

Provides Express-compatible authentication middleware guards for two distinct API surfaces — the **admin API** and the **MCP endpoint**. Authentication is performed via HTTP Bearer tokens matched against pre-configured key lists, with constant-time comparison to eliminate timing-based side-channel leaks.

---

## Exports

| Symbol | Type | Description |
|---|---|---|
| `adminAuth` | `RequestHandler` | Guards admin routes; validates Bearer token against `config.adminApiKeys` |
| `mcpAuth` | `RequestHandler` | Guards MCP routes; validates Bearer token against `config.mcpApiKeys` |

---

## Internal Helpers

### `safeCompare(a, b): boolean`
Performs a **constant-time** string comparison using Node's [`timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequalbuf1-buf2). Short-circuits on length mismatch (safe — length is not a secret here), then delegates to `timingSafeEqual` for the actual comparison, preventing timing oracle attacks against the key material.

### `extractBearerToken(req): string | null`
Reads the `Authorization` header and strips the `Bearer ` prefix (7 chars). Returns `null` if the header is absent or does not start with `Bearer `.

---

## Key Flows

### `adminAuth`
1. If `config.authDisabled` → call `next()` immediately, skip all checks.
2. Extract Bearer token; return **401 UNAUTHORIZED** if missing.
3. Test token against every key in `config.adminApiKeys` using `safeCompare`; return **403 FORBIDDEN** if no match.
4. On match → `next()`.

### `mcpAuth`
1. If `config.authDisabled` → `next()`.
2. If `config.mcpApiKeys` is empty → `next()` *(backward-compat open-access mode)*.
3. Extract Bearer token; return **401** if missing.
4. Test against `config.mcpApiKeys`; return **403** if no match.
5. On match → `next()`.

---

## Edge Cases & Gotchas

- **`authDisabled` is a master bypass** — intended for local development only; if enabled in production, *all* auth is skipped for both endpoints.
- **`mcpAuth` open-access fallback** — an empty `mcpApiKeys` array silently allows all callers. This is a deliberate backward-compatibility decision but can be a misconfiguration risk if keys are accidentally left unconfigured in production.
- **Multi-key support** — both middlewares iterate all configured keys with `Array.some`, allowing key rotation without downtime (old and new keys valid simultaneously).
- **Token trimming** — `extractBearerToken` calls `.trim()` on the extracted value, tolerating trailing whitespace in client-supplied headers.
- **Length check before `timingSafeEqual`** — mismatched lengths return `false` immediately; this does not leak secret length because the comparison is against attacker-supplied input, not a fixed secret.

---

## Error Response Shape

```json
{ "error": { "code": "UNAUTHORIZED" | "FORBIDDEN", "message": "..." } }
```

HTTP status codes: **401** (no token), **403** (token present but invalid).

---

## Dependencies

- [[../config]] — supplies `authDisabled`, `adminApiKeys`, `mcpApiKeys`
- Node built-in `crypto.timingSafeEqual`
- Express types (`Request`, `Response`, `NextFunction`)

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)
- [other:crypto (Node.js built-in)](../knowledge/deps/other-crypto-node-js-built-in.md)

### has_failure_mode
- [403 on Invalid API Key](../knowledge/failure-modes/403-on-invalid-api-key.md)
- [Key Rotation Race Window](../knowledge/failure-modes/key-rotation-race-window.md)
- [MCP Open Access Due to Empty Key List](../knowledge/failure-modes/mcp-open-access-due-to-empty-key-list.md)
- [Production Auth Bypass via authDisabled](../knowledge/failure-modes/production-auth-bypass-via-authdisabled.md)
- [401 on Missing Authorization Header](../knowledge/failure-modes/401-on-missing-authorization-header.md)

### has_pattern
- [Opt-In Security via Empty-List Fallback](../knowledge/patterns/opt-in-security-via-empty-list-fallback.md)
- [Master Bypass Flag](../knowledge/patterns/master-bypass-flag.md)
- [Constant-Time Secret Comparison](../knowledge/patterns/constant-time-secret-comparison.md)
- [Any-Of Multi-Key Validation](../knowledge/patterns/any-of-multi-key-validation.md)

### references
- [adminAuth](../knowledge/concepts/adminauth.md)
- [mcpAuth](../knowledge/concepts/mcpauth.md)

### uses_concept
- [adminAuth](../knowledge/concepts/adminauth.md)
- [Multi-Key Validation](../knowledge/concepts/multi-key-validation.md)
- [Bearer Token Authentication](../knowledge/concepts/bearer-token-authentication.md)
- [mcpAuth](../knowledge/concepts/mcpauth.md)
- [MCP Backward-Compat Open Access](../knowledge/concepts/mcp-backward-compat-open-access.md)
- [Timing-Safe Comparison](../knowledge/concepts/timing-safe-comparison.md)
- [authDisabled Flag](../knowledge/concepts/authdisabled-flag.md)
- [Bearer Token Extraction](../knowledge/concepts/bearer-token-extraction.md)

## Backlinks

### references
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)
- [Auth Middleware Test Suite (adminAuth & mcpAuth)](src--__tests__--auth.test.ts.md)

### parent_of
- [src/middleware — HTTP Security & Request Pipeline](../dirs/src--middleware.md)




