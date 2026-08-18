---
description: The gateway's HTTP surfaces — the /admin-api JSON API, the MCP control and data planes, health and metrics endpoints, and the Swagger explorer at /docs.
---

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
audit log), **never** on backend tools. Each tool is gated on three axes, all enforced in
`runSystemTool()` (`src/mcp/system-tools.ts`) rather than in the individual handlers:

- **Role tier** — mirrors the REST middleware tiers. `read` needs any resolved system role,
  `operate` needs operator or admin, `admin` needs admin. The caller's role comes from
  `resolveSystemRole()` (the env admin Bearer, or a managed `mcp_api_keys` row with an
  `adminRole`). Tools above the caller's tier are hidden from `tools/list`, not just refused.
- **Step-up** — mutating, destructive, or credential-minting tools additionally require
  `{"__confirm": true}` in the arguments **or** an elevated credential — the same gate
  `proxyToolCall` applies to sensitive backend tools.
- **Key scope** — a tool whose arguments name a client or a `(client, tool)` pair is checked
  against the calling key's own `scopes`. A target outside that scope gets the tool's ordinary
  not-found answer, so "outside your scope" and "does not exist" are indistinguishable.

| Tool                        | Tier    | Step-up                  | Description                                                                    |
| --------------------------- | ------- | ------------------------ | ------------------------------------------------------------------------------ |
| `sys_list_clients`          | read    | —                        | List registered backends (REST or MCP upstreams) with enable/health status.    |
| `sys_get_client`            | read    | —                        | Full detail for one client, including its tools and health.                    |
| `sys_list_tools`            | read    | —                        | Every `(client, tool)` pair across all registered clients.                     |
| `sys_list_bundles`          | read    | —                        | List admin-curated bundles served at `/mcp-custom/:bundleName`.                |
| `sys_list_keys`             | read    | —                        | Managed MCP API keys — metadata only; raw key values are never retrievable.    |
| `sys_metrics`               | read    | —                        | Gateway metrics snapshot: uptime, sessions, tool-call counts, avg latency.     |
| `sys_audit_tail`            | read    | —                        | Tail the admin audit log (most recent entries first).                          |
| `sys_diagnose`              | operate | —                        | Why one tool is being refused — see the note below. Read-only.                 |
| `sys_set_client_enabled`    | operate | —                        | Enable or disable a client (all its tools go unreachable while disabled).      |
| `sys_set_tool_enabled`      | operate | —                        | Enable or disable a single tool on a client.                                   |
| `sys_set_guard`             | operate | —                        | Set or clear one tool's guard policy — rate limit, timeout, API-key allowlist. |
| `sys_reset_circuit_breaker` | operate | —                        | Force a live client's circuit breaker back to `closed`.                        |
| `sys_register_client`       | operate | `__confirm` / elevated   | Register a REST/OpenAPI, MCP-upstream, or GraphQL backend (SSRF-validated).    |
| `sys_delete_client`         | operate | `__confirm` / elevated   | Permanently forget a client and purge its SQLite config.                       |
| `sys_create_bundle`         | admin   | `__confirm` / elevated   | Create a curated bundle served at `/mcp-custom/:bundleName` — see note below.  |
| `sys_mint_key`              | admin   | env Bearer + `__confirm` | Mint a managed MCP API key. Requires the **env admin Bearer** specifically.    |
| `sys_revoke_key`            | admin   | `__confirm` / elevated   | Revoke a managed MCP API key by id.                                            |

Three tiers that surprise people, and why they are set that way:

- **`sys_diagnose` is `operate`, not `read`**, even though it only reads. Its most useful output
  is the deny-code summary of the tool's recent calls, and that is the traffic explorer's data —
  `GET /admin-api/traffic` is operator-gated for exactly the same reason, so dropping this to
  `read` would hand per-call refusal records to every auditor and viewer key and put the tool out
  of step with the REST route serving the same rows. It reports guard values, the client's
  health/circuit-breaker state and the tool's enable flag; the denial counts are a capped sample
  of the newest errors (`truncated: true` means older ones inside the window were never counted,
  so treat `sampled` as a floor and narrow `windowMs` for an exact figure). Whether a per-tool key
  allowlist is in force is reported, never evaluated against the caller's own credential.
- **`sys_set_guard` needs no step-up**, matching the other `operate`-tier toggles: a guard is
  reversible in one more call, and it applies through the same policy registry the admin API's
  per-tool `PATCH` uses — so config export/import and snapshot rollback keep seeing it. Pass
  `guards: null` to clear the policy entirely; raw allowlist keys are hashed before storage.
- **`sys_create_bundle` is `admin` and needs step-up** because it creates a new serving surface.
  Composite (macro) members cannot be set through it — a composite name carries no client, so the
  per-key authorization this tool applies could not confine one; use the admin API for those.

`sys_mint_key` is the one tool that requires the literal **env admin Bearer** credential — no
managed key, however privileged, may mint another (no self-escalation).

### Gateway prompts (`prompts/list` on `/mcp`)

`POST /mcp` also serves the gateway's **own** MCP prompts, so a host like Claude Desktop or
Cursor can offer them as slash-commands and have the user's assistant walk them through
configuring this gateway. They are guidance, not capability: every step a prompt describes is an
ordinary `sys_*` call that still passes the gates above, so serving one can never widen what a
credential may do. Unlike `tools/list` they are **not** role-filtered — the text is static and
holds no gateway state — but reaching `prompts/list` at all still requires a resolved system role.

| Prompt                  | Arguments                                 | What it walks the assistant through                                                                      |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `onboard-a-backend`     | `source` (optional), `kind` (optional)    | Register one API or MCP server, review the tools it discovered, narrow them, and hand back a scoped key. |
| `diagnose-tool-failure` | `tool` (**required**), `error` (optional) | Work out which pipeline layer is refusing one tool and explain the refusal, and the fix, in plain terms. |
| `harden-this-client`    | `client` (**required**)                   | Review one client's enabled tools, guards, limits and key scoping, then propose a safer configuration.   |

Argument values are interpolated into the rendered text, so they are validated strictly:
an undeclared argument name is an error rather than being ignored, a missing required one is an
error, values are capped at 512 characters, and control characters are flattened to spaces so a
value cannot forge extra instruction lines in the gateway's voice.

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

| Endpoint        | Auth                              | Purpose                                                                                                         |
| --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /health`   | none                              | Generic health + uptime (`{ "status": "ok", "uptime_seconds": <n> }`) for load balancers and ops dashboards     |
| `GET /livez`    | none                              | Kubernetes liveness probe — always `200` while the process answers HTTP                                         |
| `GET /readyz`   | none                              | Kubernetes readiness probe — `200` only when the leader lease is held and the DB answers `SELECT 1`, else `503` |
| `GET /metrics`  | admin session or `ADMIN_API_KEYS` | Prometheus metrics (incl. `mcp_tool_calls_total{outcome}`)                                                      |
| `GET /admin`    | UI login                          | The Vue admin SPA                                                                                               |
| `GET /docs`     | dev-open / admin                  | Interactive OpenAPI explorer (Swagger UI)                                                                       |
| `GET /llms.txt` | none                              | Machine-readable self-description for an agent handed nothing but this gateway's URL — see below                |

### `GET /llms.txt`

Follows the [llms.txt](https://llmstxt.org/) convention: `text/plain`, public and
unauthenticated, so an agent given only this gateway's URL can work out what it is talking to
and how to connect. It describes the **shape** of the API — which endpoints exist, what each is
for, how to authenticate, a ready-to-paste MCP client entry — and deliberately names **no**
registered backend, tool or bundle. It reveals nothing instance-specific: the body is a constant
plus exactly one interpolated value, the base URL, so two calls to the same deployment return
byte-identical documents. The inventory stays behind a key, where `tools/list` is the
authoritative source anyway.

The advertised base URL is `GATEWAY_PUBLIC_URL` when set (taken verbatim, so a path prefix
survives), else the request's own scheme plus a `Host` reduced to a bare origin by the URL
parser. The scheme is Express's `X-Forwarded-Proto`-aware one, which only honours the forwarded
value when `TRUST_PROXY` accepts the peer — so a gateway whose TLS is terminated upstream
without `TRUST_PROXY` set advertises `http`. **Set `GATEWAY_PUBLIC_URL`** and both this document
and every generated connection snippet advertise the right address. The route has its own
per-IP rate-limit budget, separate from the install-link tier, so a crawler pulling it cannot
lock a teammate out of `/install/:token`.

## Errors

Errors are JSON: `{ "error": { "code", "message", "request_id" } }`. The `request_id` ties
a failure to the structured server log — quote it when reporting issues.

Next: **[Concepts & glossary →](/guide/concepts)** · **[Configuration →](/guide/configuration)**
