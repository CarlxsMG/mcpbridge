---
id: file_f94f127889bde0a7
kind: file
source_path: src/routes/register.ts
title: "Register Routes — Tool Registration & Schema Endpoint"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.806Z
---

# Register Routes — Tool Registration & Schema Endpoint

**Path:** `src/routes/register.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Defines two Express routes for dynamic MCP tool registration: `POST /register` and `GET /register/schema`. The POST endpoint accepts either a manual tools array or an OpenAPI spec URL, validates both against SSRF, resolves relative URLs using the requester's IP, pins the backend IP for future use, and commits the registration to the shared registry before broadcasting a `toolsChanged` event to connected MCP clients. The GET endpoint returns a pre-resolved, `$ref`-flattened JSON Schema for the registration payload, loaded eagerly at module initialization from `openapi.yaml`.

# `src/routes/register.ts`

## Purpose

Provides the HTTP surface for dynamic tool registration in the MCP proxy server. Backends call `POST /register` to advertise their tools; the server validates, discovers (if needed), and persists the registration so MCP clients can invoke those tools. A `GET /register/schema` endpoint serves the flattened JSON Schema for tooling/documentation purposes.

---

## Exports

### `registerRoutes(app: Express): void`

Attaches both routes to the provided Express application. Must be called during server bootstrap.

---

## Routes

### `POST /register`

**Middleware:** `adminAuth` → `rateLimitRegister`

**Body fields:**

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique backend identifier |
| `health_url` | ✅ | Health-check URL (absolute or relative) |
| `tools` | XOR | Manual tool definitions array |
| `openapi_url` | XOR | URL to OpenAPI spec for auto-discovery |
| `base_url` | ❌ | Override for tool base URL |
| `include_tags` | ❌ | OpenAPI tag filter (inclusion) |
| `exclude_operations` | ❌ | OpenAPI operationId filter (exclusion) |

**Key flow:**

1. **Field validation** — requires `name` + `health_url`; enforces `tools` XOR `openapi_url` mutual exclusivity.
2. **URL resolution** — relative `health_url` and `openapi_url` values are resolved to absolute using `req.ip` (e.g. `/health` → `http://<ip>/health`).
3. **SSRF protection** — all three candidate URLs (`health_url`, `base_url`, `openapi_url`) are independently validated via [[validateBackendUrl]] before any outbound request.
4. **IP pinning** — `base_url` validation returns `resolvedIp`, stored as `pinnedIp` and passed to `registry.register()` to lock the backend to a specific IP at registration time.
5. **Tool resolution** — either accepts `tools` array directly, or calls [[discoverToolsFromOpenApi]] to parse the remote spec (with optional `include_tags`/`exclude_operations` filters). Zero-tool discovery is treated as an error.
6. **Commit** — calls `registry.register(name, resolvedTools, resolvedHealthUrl, ip, resolvedBaseUrl, pinnedIp)`.
7. **Broadcast** — calls `notifyToolsChanged()` to push an SSE/WS event to all connected MCP clients.
8. **Response** — `200 { status, name, tools_count, source }`.

### `GET /register/schema`

Returns the pre-resolved `RegistrationPayload` JSON Schema (all `$ref` pointers inlined). Served as `application/schema+json`. Returns `503` if schema failed to load at startup.

---

## Module-Level Schema Pre-loading

At module load time, `openapi.yaml` is read synchronously, `components.schemas` is extracted, and `RegistrationPayload` is deep-cloned then passed through `resolveRefs()`. The result is cached in `_resolvedSchema`. Errors are swallowed with a `warn` log so they don't crash the server.

---

## `resolveRefs(obj, visited)`

Recursively resolves `$ref` pointers within a JSON Schema object tree:
- Splits `$ref` on `/` and pops the last segment to look up in `_schemaComponents`.
- Deep-clones each referenced schema via `JSON.parse(JSON.stringify(...))` before recursing to avoid cross-contamination.
- Uses a `visited: Set<object>` for cycle detection — returns `obj["$ref"] ?? obj` on revisit to break circular references.
- Mutates in place for non-`$ref` keys.

---

## Error Codes

| Code | HTTP | Scenario |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing fields, bad URLs, SSRF failure, non-array `tools` |
| `DISCOVERY_ERROR` | 400 | OpenAPI fetch/parse failure or zero tools discovered |
| `SCHEMA_UNAVAILABLE` | 503 | Schema pre-load failed at startup |

---

## Gotchas

- `resolveRefs` mutates `obj` for non-`$ref` keys. The top-level call passes `JSON.parse(JSON.stringify(...))` to protect the original, but nested clones are mutated.
- Relative URL resolution assumes HTTP (`http://`) — HTTPS backends must supply absolute URLs.
- The `visited` set guards against cycles but returns `obj["$ref"] ?? obj` raw on a revisit, which may leave unresolved `$ref` strings in the output for genuinely circular schemas.
- `req.ip` may be `undefined`; fallback is `req.socket?.remoteAddress` then `127.0.0.1`.

---

## References

### has_dep
- [npm:yaml](../knowledge/deps/npm-yaml.md)
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Registry Throws on Register](../knowledge/failure-modes/registry-throws-on-register.md)
- [Undefined req.ip](../knowledge/failure-modes/undefined-req-ip.md)
- [SSRF Bypass via Relative URL](../knowledge/failure-modes/ssrf-bypass-via-relative-url.md)
- [Zero Tools from OpenAPI](../knowledge/failure-modes/zero-tools-from-openapi.md)
- [Circular $ref in Schema](../knowledge/failure-modes/circular-ref-in-schema.md)
- [Schema Pre-load Failure](../knowledge/failure-modes/schema-pre-load-failure.md)

### has_pattern
- [Defensive URL Normalization](../knowledge/patterns/defensive-url-normalization.md)
- [Eager Schema Caching](../knowledge/patterns/eager-schema-caching.md)
- [Mutual Exclusivity Guard](../knowledge/patterns/mutual-exclusivity-guard.md)
- [Deep Clone Before Mutation](../knowledge/patterns/deep-clone-before-mutation.md)
- [IP Pinning at Registration](../knowledge/patterns/ip-pinning-at-registration.md)

### references
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [IP Validator — SSRF-Guard for Backend URL Validation](src--security--ip-validator.ts.md)
- [OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs](src--openapi-discovery.ts.md)
- [Rate Limiter Middleware — Sliding Window, In-Memory](src--middleware--rate-limiter.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)
- [src/openapi.yaml — MCP REST Bridge OpenAPI 3.1 spec](src--openapi.yaml.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [Tool Registration](../knowledge/concepts/tool-registration.md)
- [adminAuth](../knowledge/concepts/adminauth.md)
- [tools XOR openapi_url](../knowledge/concepts/tools-xor-openapi-url.md)
- [SSRF Protection](../knowledge/concepts/ssrf-protection.md)
- [rateLimitRegister](../knowledge/concepts/ratelimitregister.md)
- [notifyToolsChanged](../knowledge/concepts/notifytoolschanged.md)
- [RegistrationPayload](../knowledge/concepts/registrationpayload.md)
- [Relative URL Resolution](../knowledge/concepts/relative-url-resolution.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### parent_of
- [src/routes — Express Route Handlers for MCP Proxy Gateway](../dirs/src--routes.md)




