# Architecture

MCP REST Bridge sits between MCP clients and your backends. It keeps a dynamic registry of
clients and their tools, advertises a unified tool list to MCP clients, and proxies each
call to the right backend through a single, uniform guard pipeline.

## The request path

<RequestPath />

Every policy is enforced at the **dispatch point** (`proxyToolCall`), never as HTTP
middleware — MCP multiplexes many tools over one `POST /mcp` route, so the bridge must know
_which_ tool is being called before it can apply per-tool rules.

## Four ways to serve tools

| Mode                 | Endpoint                      | What it exposes                              |
| -------------------- | ----------------------------- | -------------------------------------------- |
| **Aggregated**       | `POST /mcp`                   | Every enabled tool from every enabled client |
| **Per-client shard** | `/mcp/:clientName`            | Only one client's tools                      |
| **Curated bundle**   | `/mcp-custom/:bundleName`     | A hand-picked cross-client subset            |
| **Legacy SSE**       | `GET /sse` + `POST /messages` | The same tools for older MCP clients         |

Bundles are a pure narrowing filter applied _before_ dispatch — all guards, breakers and
SSRF checks behave identically regardless of which mode a call came through.

## Two kinds of backend

- **REST clients** — registered from an OpenAPI/Swagger spec (auto-discovery) or a manual
  tool list. Each tool maps to an HTTP method + path on the backend's base URL.
- **MCP upstreams** — existing MCP servers (Streamable HTTP or SSE) registered as
  `kind: "mcp"`. The bridge connects out, discovers their tools, and re-exposes them.

Both are keyed by the same abstract `client__tool` identity, so every governance
feature — guards, guardrails, RBAC, bundles, usage, audit — applies to both unchanged.

## Storage & runtime

- **Runtime:** a single [Bun](https://bun.sh) process (Express 5 + `@modelcontextprotocol/sdk`).
- **Persistence:** `bun:sqlite` — one file, no external database, no ORM. Admin config
  (enable flags, guards, bundles, keys, audit, users, teams) lives here; the live registry
  is hydrated from it at boot.
- **Admin UI:** a separate Vue 3 + Vite SPA served at `/admin`, talking to the JSON admin
  API at `/admin-api/*`.

## Health & resilience

A background loop health-checks each client and auto-evicts unhealthy ones (with a `ping`
probe for MCP upstreams). Per-tool **circuit breakers** trip on repeated failures, and an
optional **canary/failover** secondary can take over when a primary breaker opens — without
falsely closing the primary's breaker.

Next: **[Security →](/guide/security)** · **[Deployment →](/guide/deployment)**
