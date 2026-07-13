# API reference

The bridge exposes a few distinct HTTP surfaces. The backend also serves an **interactive
OpenAPI explorer at `/docs`** (Swagger UI, generated from `src/openapi.yaml`) — open in
development, behind admin auth in production.

## MCP endpoints (for tool callers)

Where MCP clients connect. Auth: `MCP_API_KEYS` Bearer, or a JWT when `JWT_JWKS_URL` is set.

| Endpoint                           | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `GET/POST /mcp/:clientName`        | Data plane — one backend's tools (sharded)                          |
| `GET/POST /mcp-custom/:bundleName` | Data plane — a curated cross-backend [bundle](/guide/bundles)       |
| `POST /mcp`                        | Control plane — `sys_*` gateway-management tools, not backend tools |

All three speak **Streamable HTTP**; the legacy SSE transport (`/sse` + `/messages`) was
removed. `/mcp` has its own fail-closed auth (a real system role is required — no
"unconfigured means open" fallback).

## Control plane — `sys_*` gateway-management tools

`POST /mcp` advertises a fixed catalog of gateway-management tools — thin MCP adapters over
the same domain logic the REST admin API (`/admin-api/*`) already exposes. They operate on the
gateway itself (register and inspect backends, toggle clients and tools, mint keys, tail the
audit log), **never** on backend tools. Each tool is gated on two axes, both enforced in
`runSystemTool()` (`src/mcp/system-tools.ts`):

- **Role tier** — mirrors the REST middleware tiers. `read` needs any resolved system role,
  `operate` needs operator or admin, `admin` needs admin. The caller's role comes from
  `resolveSystemRole()` (the env admin Bearer, or a managed `mcp_api_keys` row with an
  `adminRole`). Tools above the caller's tier are hidden from `tools/list`, not just refused.
- **Step-up** — mutating, destructive, or credential-minting tools additionally require
  `{"__confirm": true}` in the arguments **or** an elevated credential — the same gate
  `proxyToolCall` applies to sensitive backend tools.

| Tool                        | Tier    | Step-up                  | Description                                                                 |
| --------------------------- | ------- | ------------------------ | --------------------------------------------------------------------------- |
| `sys_list_clients`          | read    | —                        | List registered backends (REST or MCP upstreams) with enable/health status. |
| `sys_get_client`            | read    | —                        | Full detail for one client, including its tools and health.                 |
| `sys_list_tools`            | read    | —                        | Every `(client, tool)` pair across all registered clients.                  |
| `sys_list_bundles`          | read    | —                        | List admin-curated bundles served at `/mcp-custom/:bundleName`.             |
| `sys_list_keys`             | read    | —                        | Managed MCP API keys — metadata only; raw key values are never retrievable. |
| `sys_metrics`               | read    | —                        | Gateway metrics snapshot: uptime, sessions, tool-call counts, avg latency.  |
| `sys_audit_tail`            | read    | —                        | Tail the admin audit log (most recent entries first).                       |
| `sys_set_client_enabled`    | operate | —                        | Enable or disable a client (all its tools go unreachable while disabled).   |
| `sys_set_tool_enabled`      | operate | —                        | Enable or disable a single tool on a client.                                |
| `sys_reset_circuit_breaker` | operate | —                        | Force a live client's circuit breaker back to `closed`.                     |
| `sys_register_client`       | operate | `__confirm` / elevated   | Register a REST/OpenAPI, MCP-upstream, or GraphQL backend (SSRF-validated). |
| `sys_delete_client`         | operate | `__confirm` / elevated   | Permanently forget a client and purge its SQLite config.                    |
| `sys_mint_key`              | admin   | env Bearer + `__confirm` | Mint a managed MCP API key. Requires the **env admin Bearer** specifically. |
| `sys_revoke_key`            | admin   | `__confirm` / elevated   | Revoke a managed MCP API key by id.                                         |

`sys_mint_key` is the one tool that requires the literal **env admin Bearer** credential — no
managed key, however privileged, may mint another (no self-escalation).

## Registration

Register or re-discover backends. Auth: admin session **or** `ADMIN_API_KEYS` Bearer.

| Endpoint               | Purpose                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /register`       | Register a REST backend (`openapi_url`, `tools`, `curl_input`, or `postman_collection`), an MCP upstream (`kind: "mcp"`, `mcp_url`), or a GraphQL API (`kind: "graphql"`, `graphql_url`) |
| `GET /register/schema` | JSON Schema for the registration payload                                                                                                                                                 |

See [Registering backends](/guide/registering-backends) for the payload fields.

## Admin API — `/admin-api/*`

The JSON management API behind the Vue admin UI. Auth: session cookie (with CSRF on
mutations) **or** `ADMIN_API_KEYS` Bearer. Role-gated; every mutation is audited.

| Group           | Examples                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `POST /admin-api/auth/login`, `/logout`, `GET /admin-api/auth/me`                                                                                                             |
| Servers & tools | `GET /admin-api/clients` (create via `POST /register`), `GET/PATCH/DELETE /admin-api/clients/:name`, `PATCH /admin-api/clients` (bulk enable/disable), `GET /admin-api/tools` |
| Curation        | `/admin-api/bundles*`, `/composites*`                                                                                                                                         |
| Access          | `/admin-api/mcp-keys*`, `/consumers*`, `/policies*`, `/users*`, `/teams*`                                                                                                     |
| Observability   | `/admin-api/overview`, `/usage/*`, `/alerts*`, `/audit-log*`                                                                                                                  |
| Config & ops    | `/admin-api/config/*` (export/import, snapshots, rollback), `/schedules*`, `/discovery/preview`                                                                               |

The full request/response shapes are in the Swagger UI at **`/docs`**.

## Operations

| Endpoint       | Auth                              | Purpose                                                                                                         |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /health`  | none                              | Generic health + uptime (`{ "status": "ok", "uptime_seconds": <n> }`) for load balancers and ops dashboards     |
| `GET /livez`   | none                              | Kubernetes liveness probe — always `200` while the process answers HTTP                                         |
| `GET /readyz`  | none                              | Kubernetes readiness probe — `200` only when the leader lease is held and the DB answers `SELECT 1`, else `503` |
| `GET /metrics` | admin session or `ADMIN_API_KEYS` | Prometheus metrics (incl. `mcp_tool_calls_total{outcome}`)                                                      |
| `GET /admin`   | UI login                          | The Vue admin SPA                                                                                               |
| `GET /docs`    | dev-open / admin                  | Interactive OpenAPI explorer (Swagger UI)                                                                       |

## Errors

Errors are JSON: `{ "error": { "code", "message", "request_id" } }`. The `request_id` ties
a failure to the structured server log — quote it when reporting issues.

Next: **[Concepts & glossary →](/guide/concepts)** · **[Configuration →](/guide/configuration)**
