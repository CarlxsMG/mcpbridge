---
id: file_ea28011f26d53007
kind: file
source_path: src/openapi.yaml
title: "src/openapi.yaml — MCP REST Bridge OpenAPI 3.1 spec"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.804Z
---

# src/openapi.yaml — MCP REST Bridge OpenAPI 3.1 spec

**Path:** `src/openapi.yaml`  
**Kind:** `file`  
**Model:** `opus`  
**Generated:** `opus@item-doc/v1`

> OpenAPI 3.1.0 specification for the MCP REST Bridge, a proxy translating Model Context Protocol calls into REST. Defines registration paths (POST /register with manual tools or openapi_url auto-discovery, GET /register/schema), introspection (/clients, /clients/{name}/tools, /metrics, /health), and dual MCP transports: Streamable HTTP (POST/GET/DELETE /mcp keyed by mcp-session-id header) and legacy SSE (GET /sse, POST /messages with sessionId query). Components declare AdminAuth and McpAuth bearer schemes plus schemas RegisterClientRequest, RestToolDefinition, InputSchema (JSON Schema 2020-12), RegisteredClient, ApiError envelope, JsonRpcMessage, and JsonRpcError covering codes UNAUTHORIZED, FORBIDDEN, CLIENT_NOT_FOUND, RATE_LIMITED, and JSON-RPC -32000 session errors.

# src/openapi.yaml

OpenAPI 3.1.0 specification for the **MCP REST Bridge**, a proxy that translates Model Context Protocol (MCP) calls into REST API calls.

## Paths

### Registration & Introspection (AdminAuth)
- **POST /register** — Register a client with either a manual `tools` array or `openapi_url` auto-discovery. Returns `status`, `name`, `tools_count`, `source`.
- **GET /register/schema** — Retrieve the registration payload JSON Schema.
- **GET /clients** — List registered clients with health status.
- **GET /clients/{name}/tools** — Return full tool definitions for a named client.
- **GET /metrics** — Expose uptime, sessions, and circuit-breaker stats.
- **GET /health** — Liveness probe (no auth).

### MCP Transport (McpAuth)
- **POST /mcp**, **GET /mcp**, **DELETE /mcp** — Streamable HTTP transport keyed by the `mcp-session-id` header (initiate/resume, SSE notification stream, terminate).
- **GET /sse**, **POST /messages** — Legacy SSE transport using a `sessionId` query parameter for backwards compatibility.

## Components

### Security
- `AdminAuth` bearer (`ADMIN_API_KEYS`) gates registration & introspection.
- `McpAuth` bearer (`MCP_API_KEYS`) gates MCP transport.
- Both bypass when `AUTH_DISABLED=true`.

### Schemas
- **RegistrationPayload / RegisterClientRequest** — `name`, `health_url`, optional `tools`, `base_url`, `openapi_url`, `include_tags`, `exclude_operations`.
- **RestToolDefinition** — One MCP tool: `name`, `method` (GET/POST/PUT/PATCH/DELETE), `endpoint` (Express-style `:param` placeholders), `description`, `inputSchema`.
- **InputSchema** — JSON Schema draft 2020-12, root `type: object`, `properties`, `required`.
- **RegisteredClient** — Runtime view: `name`, `ip`, `status` (healthy/unreachable), `tools_count`, resolved `health_url`/`base_url`.
- **ApiError** — REST error envelope: `error.code` (SCREAMING_SNAKE_CASE: `VALIDATION_ERROR`, `CLIENT_NOT_FOUND`, `DISCOVERY_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`), `message`, optional `field`.
- **JsonRpcMessage** — JSON-RPC 2.0 envelope (`jsonrpc`, `id`, `method`, `params`, `result`, `error`).
- **JsonRpcError** — JSON-RPC 2.0 error; uses `-32000` for bridge session-level errors.

### Standard Error Mapping
401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `CLIENT_NOT_FOUND` / Session not found, 429 `RATE_LIMITED`, 503 capacity errors — surfaced through `ApiError` or `JsonRpcError` refs.

---

## References

### has_failure_mode
- [Unknown MCP session](../knowledge/failure-modes/unknown-mcp-session.md)
- [Auth bypass in production](../knowledge/failure-modes/auth-bypass-in-production.md)
- [Rate limit / capacity exhaustion](../knowledge/failure-modes/rate-limit-capacity-exhaustion.md)
- [Unhealthy registered client](../knowledge/failure-modes/unhealthy-registered-client.md)
- [Conflicting registration modes](../knowledge/failure-modes/conflicting-registration-modes.md)
- [OpenAPI discovery failure](../knowledge/failure-modes/openapi-discovery-failure.md)

### has_pattern
- [Dual MCP transports](../knowledge/patterns/dual-mcp-transports.md)
- [Dual-mode registration](../knowledge/patterns/dual-mode-registration.md)
- [Split bearer-token surfaces](../knowledge/patterns/split-bearer-token-surfaces.md)
- [Session-keyed MCP state](../knowledge/patterns/session-keyed-mcp-state.md)
- [Standardized error envelopes](../knowledge/patterns/standardized-error-envelopes.md)

### references
- [Circuit Breaker](../knowledge/patterns/circuit-breaker.md)

### uses_concept
- [AdminAuth / McpAuth](../knowledge/concepts/adminauth-mcpauth.md)
- [MCP REST Bridge](../knowledge/concepts/mcp-rest-bridge.md)
- [Streamable HTTP Transport](../knowledge/concepts/streamable-http-transport.md)
- [ApiError envelope](../knowledge/concepts/apierror-envelope.md)
- [JSON-RPC error -32000](../knowledge/concepts/json-rpc-error-32000.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [OpenAPI auto-discovery](../knowledge/concepts/openapi-auto-discovery.md)
- [Legacy SSE transport](../knowledge/concepts/legacy-sse-transport.md)

## Backlinks

### references
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




