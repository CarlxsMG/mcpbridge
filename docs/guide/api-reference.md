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

| Group           | Examples                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `POST /admin-api/auth/login`, `/logout`, `GET /auth/me`                                                                                              |
| Servers & tools | `GET/POST /admin-api/clients`, `GET/PATCH/DELETE /admin-api/clients/:name`, `PATCH /admin-api/clients` (bulk enable/disable), `GET /admin-api/tools` |
| Curation        | `/admin-api/bundles*`, `/composites*`                                                                                                                |
| Access          | `/admin-api/mcp-keys*`, `/consumers*`, `/policies*`, `/users*`, `/teams*`                                                                            |
| Observability   | `/admin-api/overview`, `/usage/*`, `/alerts*`, `/audit-log*`                                                                                         |
| Config & ops    | `/admin-api/config/*` (export/import, snapshots, rollback), `/schedules*`, `/discovery/preview`                                                      |

The full request/response shapes are in the Swagger UI at **`/docs`**.

## Operations

| Endpoint       | Auth                              | Purpose                                                                         |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `GET /health`  | none                              | Liveness probe (`{ "status": "ok", "uptime_seconds": <n> }`) for load balancers |
| `GET /metrics` | admin session or `ADMIN_API_KEYS` | Prometheus metrics (incl. `mcp_tool_calls_total{outcome}`)                      |
| `GET /admin`   | UI login                          | The Vue admin SPA                                                               |
| `GET /docs`    | dev-open / admin                  | Interactive OpenAPI explorer (Swagger UI)                                       |

## Errors

Errors are JSON: `{ "error": { "code", "message", "request_id" } }`. The `request_id` ties
a failure to the structured server log — quote it when reporting issues.

Next: **[Concepts & glossary →](/guide/concepts)** · **[Configuration →](/guide/configuration)**
