# Architecture

MCP REST Bridge sits between MCP clients and your backends. It keeps a dynamic registry of
clients and their tools, advertises a unified tool list to MCP clients, and proxies each
call to the right backend through a single, uniform guard pipeline.

## The request path

<RequestPath />

Every policy is enforced at the **dispatch point** (`proxyToolCall`), never as HTTP
middleware — MCP multiplexes many tools over one JSON-RPC route per scope, so the bridge
must know _which_ tool is being called before it can apply per-tool rules.

## Two planes, three endpoints

| Plane       | Endpoint                  | What it exposes                                                           |
| ----------- | ------------------------- | ------------------------------------------------------------------------- |
| **Control** | `POST /mcp`               | Gateway management + data retrieval (`sys_*` tools) — never backend tools |
| **Data**    | `/mcp/:clientName`        | One client's backend tools                                                |
| **Data**    | `/mcp-custom/:bundleName` | A hand-picked cross-client subset (tools and/or composite macros)         |

`/mcp` is not a flattened view of every backend tool — that redundant "aggregated" mode was
removed. If you want cross-client backend tools in one session, curate a bundle. `/mcp`
itself is the control plane: an LLM client connects there to inspect and operate the gateway
(list/register/enable clients, mint keys, tail the audit log, ...), gated by its own
fail-closed auth (`rootMcpAuth` — no "unconfigured means open" fallback, unlike the two data
endpoints) and a per-tool role tier (read/operate/admin) plus step-up confirmation for
sensitive actions. See `src/mcp/system-tools.ts`.

Bundle tool/composite selection is a pure narrowing filter applied _before_ dispatch — all
guards, breakers and SSRF checks behave identically regardless of which data endpoint a call
came through. The legacy SSE transport (`GET /sse` + `POST /messages`) was removed alongside
aggregation; Streamable HTTP is the only inbound MCP transport now.

## Three kinds of backend

- **REST clients** — registered from an OpenAPI/Swagger spec (auto-discovery) or a manual
  tool list. Each tool maps to an HTTP method + path on the backend's base URL.
- **GraphQL clients** — registered as `kind: "graphql"`. The bridge introspects the schema
  and generates one tool per query/mutation.
- **MCP upstreams** — existing MCP servers (Streamable HTTP or SSE) registered as
  `kind: "mcp"`. The bridge connects out, discovers their tools, and re-exposes them.

All three are keyed by the same abstract `client__tool` identity, so every governance
feature — guards, guardrails, RBAC, bundles, usage, audit — applies to all of them unchanged.

## Storage & runtime

- **Runtime:** a single [Bun](https://bun.sh) process (Express 5 + `@modelcontextprotocol/sdk`).
- **Persistence:** `bun:sqlite` — one file, no external database, no ORM. Admin config
  (enable flags, guards, bundles, keys, audit, users, teams) lives here; the live registry
  is hydrated from it at boot.
- **Admin UI:** a separate Vue 3 + Vite SPA served at `/admin`, talking to the JSON admin
  API at `/admin-api/*`.

## Health & resilience

A background loop health-checks each client and auto-evicts unhealthy ones (with a `ping`
probe for MCP upstreams). Per-client **circuit breakers** trip on repeated failures, and an
optional **canary/failover** secondary can take over when a primary breaker opens — without
falsely closing the primary's breaker.

For the reasoning behind these choices, see the
**[Architecture Decision Records →](/architecture/decisions/0001-two-planes-three-endpoints)**
and the reliability **[SLOs →](/architecture/slos)**.

Next: **[Security →](/guide/security)** · **[Deployment →](/guide/deployment)**
