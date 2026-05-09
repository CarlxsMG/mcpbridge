---
id: file_55620843c5000655
kind: file
source_path: src/config.ts
title: "Application Configuration Module (src/config.ts)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.785Z
---

# Application Configuration Module (src/config.ts)

**Path:** `src/config.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Centralized runtime configuration for the MCP gateway server. Exports a single `config` object populated entirely from environment variables with hardcoded defaults. Covers HTTP port, timeout budgets (tool calls, health checks, OpenAPI discovery), session lifecycle (TTL, max count), network security (private IP policy, allowed hosts/origins, CORS), authentication (bypass flag, admin and MCP API key arrays), three-tier rate limiting (register, MCP, global), structured log format, and a consecutive-failure threshold for circuit-breaking. Array fields are parsed from comma-separated env strings; `trustProxy` accepts either a boolean string or a numeric proxy hop count.

# `src/config.ts` — Application Configuration Module

## Purpose

Single source of truth for all runtime tunables. Reads from environment variables and falls back to safe, sensible defaults. No imports — zero dependencies. Every other module that needs a tunable should import from here rather than reading `process.env` directly.

---

## Exports

### `config` _(object, exported const)_

| Field | Env Var | Default | Type | Notes |
|---|---|---|---|---|
| `port` | `PORT` | `3000` | `number` | HTTP listen port |
| `toolCallTimeoutMs` | `TOOL_CALL_TIMEOUT_MS` | `30_000` | `number` | Max ms to await a tool call response |
| `healthCheckTimeoutMs` | `HEALTH_CHECK_TIMEOUT_MS` | `5_000` | `number` | Per-request health check deadline |
| `healthCheckIntervalMs` | `HEALTH_CHECK_INTERVAL_MS` | `30_000` | `number` | Polling cadence for background health checks |
| `openapiDiscoveryTimeoutMs` | `OPENAPI_DISCOVERY_TIMEOUT_MS` | `10_000` | `number` | Deadline for OpenAPI spec fetch |
| `sessionTtlMs` | `SESSION_TTL_MS` | `1_800_000` | `number` | Session lifetime (30 min default) |
| `maxSessions` | `MAX_SESSIONS` | `100` | `number` | Hard cap on concurrent sessions |
| `allowPrivateIps` | `ALLOW_PRIVATE_IPS` | `false` | `boolean` | Strict `=== "true"` check |
| `allowedHosts` | `ALLOWED_HOSTS` | `[]` | `string[]` | Comma-separated; empty = no host restriction |
| `allowedOrigins` | `ALLOWED_ORIGINS` | `["http://localhost:*"]` | `string[]` | Default permits localhost wildcard |
| `corsOrigins` | `CORS_ORIGINS` | `[]` | `string[]` | Separate from `allowedOrigins`; used for CORS header |
| `authDisabled` | `AUTH_DISABLED` | `false` | `boolean` | Strict `=== "true"` check |
| `adminApiKeys` | `ADMIN_API_KEYS` | `[]` | `string[]` | Comma-separated; trimmed and filtered |
| `mcpApiKeys` | `MCP_API_KEYS` | `[]` | `string[]` | Comma-separated; trimmed and filtered |
| `rateLimitRegister` | `RATE_LIMIT_REGISTER` | `10` | `number` | Req/window for registration endpoint |
| `rateLimitMcp` | `RATE_LIMIT_MCP` | `100` | `number` | Req/window for MCP endpoints |
| `rateLimitGlobal` | `RATE_LIMIT_GLOBAL` | `1000` | `number` | Req/window global cap |
| `logFormat` | `LOG_FORMAT` | `"json"` | `"json" \| "text"` | Cast, not validated at runtime |
| `maxConsecutiveFailures` | `MAX_CONSECUTIVE_FAILURES` | `10` | `number` | Circuit-breaker trip threshold |
| `trustProxy` | `TRUST_PROXY` | `false` | `boolean \| number` | `"true"` → `true`; numeric string → hop count; else `false` |

---

## Key Flows

### Boolean flags
`allowPrivateIps` and `authDisabled` use a strict string equality check (`=== "true"`). Any other value — including `"1"`, `"yes"`, or `"TRUE"` — evaluates to `false`.

### Array fields
`allowedHosts`, `allowedOrigins`, `corsOrigins`, `adminApiKeys`, `mcpApiKeys` are parsed via `.split(",").map(h => h.trim()).filter(Boolean)`. Whitespace-only entries are dropped; an unset var yields `[]` (or the hardcoded default for `allowedOrigins`).

### `trustProxy` dual-type parsing
```
TRUST_PROXY === "true"  → true        (boolean, trust all proxies)
TRUST_PROXY === "2"     → 2           (number, trust N hops)
TRUST_PROXY unset/"false" → false     (disable)
TRUST_PROXY === "0"     → false       (0 || false evaluates to false — see Gotchas)
```

---

## Gotchas

1. **Zero values are swallowed.** The `Number(env) || default` idiom means setting an env var to `"0"` falls through to the default (e.g., `PORT=0` → port `3000`). This affects all numeric fields.
2. **`logFormat` is cast, not validated.** An invalid value like `LOG_FORMAT=xml` is accepted without error; downstream consumers must guard against unknown formats.
3. **`corsOrigins` vs `allowedOrigins` are distinct.** Both control origin-related access but are separate lists consumed by different middleware layers. Setting one does not imply the other.
4. **`authDisabled=true` in production bypasses all API key checks.** No safeguard in this module prevents misuse in non-development environments.
5. **Empty `adminApiKeys` with `authDisabled=false`** means no admin operations can succeed — no error is thrown at startup.

---

## References

### has_failure_mode
- [No admin access when key list is empty](../knowledge/failure-modes/no-admin-access-when-key-list-is-empty.md)
- [Non-boolean TRUST_PROXY=0 treated as false](../knowledge/failure-modes/non-boolean-trust-proxy-0-treated-as-false.md)
- [Invalid logFormat silently accepted](../knowledge/failure-modes/invalid-logformat-silently-accepted.md)
- [corsOrigins / allowedOrigins misconfiguration](../knowledge/failure-modes/corsorigins-allowedorigins-misconfiguration.md)
- [Auth bypassed in production](../knowledge/failure-modes/auth-bypassed-in-production.md)
- [Zero-value numeric env var ignored](../knowledge/failure-modes/zero-value-numeric-env-var-ignored.md)

### has_pattern
- [Comma-Separated String Parsing for Array Config](../knowledge/patterns/comma-separated-string-parsing-for-array-config.md)
- [Environment-Driven Configuration with Inline Defaults](../knowledge/patterns/environment-driven-configuration-with-inline-defaults.md)
- [Strict Boolean String Check](../knowledge/patterns/strict-boolean-string-check.md)
- [Dual-Type Env Var Parsing (trustProxy)](../knowledge/patterns/dual-type-env-var-parsing-trustproxy.md)

### references
- [CORS Middleware — Origin Allowlist & Preflight Handler](src--middleware--cors.ts.md)
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)

### uses_concept
- [Auth Disabled Flag](../knowledge/concepts/auth-disabled-flag.md)
- [Trust Proxy](../knowledge/concepts/trust-proxy.md)
- [CORS Origins](../knowledge/concepts/cors-origins.md)
- [Session TTL](../knowledge/concepts/session-ttl.md)
- [Max Sessions](../knowledge/concepts/max-sessions.md)
- [MCP API Keys](../knowledge/concepts/mcp-api-keys.md)
- [Tool Call Timeout](../knowledge/concepts/tool-call-timeout.md)
- [Allow Private IPs](../knowledge/concepts/allow-private-ips.md)
- [OpenAPI Discovery Timeout](../knowledge/concepts/openapi-discovery-timeout.md)
- [config](../knowledge/concepts/config.md)
- [Log Format](../knowledge/concepts/log-format.md)
- [Allowed Origins](../knowledge/concepts/allowed-origins.md)
- [Admin API Keys](../knowledge/concepts/admin-api-keys.md)
- [Three-tier Rate Limiting](../knowledge/concepts/three-tier-rate-limiting.md)
- [Max Consecutive Failures](../knowledge/concepts/max-consecutive-failures.md)

## Backlinks

### references
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [CORS Middleware — Origin Allowlist & Preflight Handler](src--middleware--cors.ts.md)
- [Origin Validator Middleware](src--middleware--origin-validator.ts.md)
- [OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs](src--openapi-discovery.ts.md)
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)
- [Auth Middleware Test Suite (adminAuth & mcpAuth)](src--__tests__--auth.test.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




