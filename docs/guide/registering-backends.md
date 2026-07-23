# Registering backends

A backend is a **REST API**, a **GraphQL API**, or an existing **MCP server** — each turned
into (or re-exposing) MCP tools through the same guard stack. Register from the admin UI
(**Add server**) or the `POST /register` API. Registration requires admin auth — a session,
or an `ADMIN_API_KEYS` Bearer token.

::: tip Ready-to-send samples
The repo's [`examples/register/`](https://github.com/CarlxsMG/mcpbridge/tree/main/examples/register)
directory has a complete `POST /register` body for each mode below (OpenAPI, cURL import, Postman,
manual, GraphQL, MCP upstream), plus an [`examples/gateway.yaml`](https://github.com/CarlxsMG/mcpbridge/blob/main/examples/gateway.yaml)
for registering the same backends as config-as-code.
:::

## REST from an OpenAPI spec

Point at the spec and the bridge generates one tool per operation:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'
```

Useful fields:

| Field                                 | Purpose                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `openapi_url`                         | Discover tools from a spec (mutually exclusive with `tools`, `curl_input`, `postman_collection`) |
| `tools`                               | Provide tool definitions manually when there's no spec                                           |
| `curl_input`                          | Derive one tool from a pasted `curl` command (below)                                             |
| `postman_collection`                  | Derive tools from a Postman Collection v2.1 export (below)                                       |
| `base_url`                            | Override the API base (defaults to the host of `health_url`)                                     |
| `include_tags` / `exclude_operations` | Select exactly which operations become tools (OpenAPI discovery only)                            |
| `retry_non_safe_methods`              | Allow retries on non-idempotent methods (off by default)                                         |

`tools`, `openapi_url`, `curl_input` and `postman_collection` are **mutually exclusive** —
provide exactly one.

## From a cURL command or Postman collection

No OpenAPI spec? Paste a working `curl` invocation and the bridge derives a single tool from
its method, URL, headers and body:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "internal-search",
    "health_url": "https://search.internal.example.com/health",
    "curl_input": "curl -X GET '\''https://search.internal.example.com/v1/query?q=hello'\'' -H '\''Authorization: Bearer TOKEN'\''"
  }'
```

Or point `postman_collection` at a Postman Collection v2.1 export (an object, or its
JSON-encoded string form) to derive one tool per request in the collection — useful when a
team already maintains one instead of an OpenAPI spec:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "team-api",
    "health_url": "https://team-api.example.com/health",
    "postman_collection": "{\"info\":{\"schema\":\"https://schema.getpostman.com/json/collection/v2.1.0/collection.json\"},\"item\":[{\"name\":\"Get order\",\"request\":{\"method\":\"GET\",\"url\":\"https://team-api.example.com/orders/:id\"}}]}"
  }'
```

Nested folders are flattened into an underscore-joined tool-name prefix (`Users` › `Get`
becomes `users_get`) so identically-named requests in different folders don't collide.

## Manual tool definitions

No spec, no `curl`, no Postman? Describe the tools yourself with a `tools` array. Each entry
is an HTTP method + path on `base_url` plus a JSON Schema for its arguments; Express-style
`:placeholders` in the path are filled from the call's arguments at dispatch time:

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "customer_service",
    "health_url": "https://api.example.com/health",
    "base_url": "https://api.example.com",
    "tools": [
      {
        "name": "get_customer",
        "method": "GET",
        "endpoint": "/customers/:id",
        "description": "Retrieve a single customer record by ID.",
        "inputSchema": {
          "type": "object",
          "properties": { "id": { "type": "string", "description": "The customer ID." } },
          "required": ["id"]
        }
      }
    ]
  }'
```

## A GraphQL API

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "storefront",
    "kind": "graphql",
    "graphql_url": "https://storefront.example.com/graphql"
  }'
```

The bridge introspects the schema and generates one tool per query and mutation
(`include_mutations: false` to expose queries only). `health_url` is optional — it defaults to
`graphql_url`, but many GraphQL servers reject a bare `GET` on the operation endpoint, so
supplying a dedicated liveness endpoint avoids false-positive health failures and auto-eviction
(the response includes a `warnings` array if you skip it).

## An existing MCP server (upstream)

```bash
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

The bridge connects out, discovers the upstream's tools, and re-exposes them through the
same guard stack. Both `streamable-http` and `sse` upstream transports are supported.

## From the install catalog

The admin UI also has a **catalog** page: a curated, one-click-install marketplace merging
built-in server templates with any custom ones an admin adds. Installing a catalog entry runs
through the exact same registration path (SSRF check, discovery, IP pinning) as a hand-typed
`POST /register` — it's a shortcut to a prefilled form, not a separate code path.

## What happens on registration

- **SSRF check + IP pinning.** The backend URL is validated and its resolved IP pinned, so
  a later DNS change can't redirect it. Loopback/private addresses are rejected unless
  `ALLOW_PRIVATE_IPS=true` (local dev only).
- **Health monitoring.** A background loop checks each backend and auto-evicts unhealthy
  ones (a `ping` probe for MCP upstreams). Eviction never destroys admin config.
- **Tools go live** immediately — on the backend's own shard (`/mcp/:name`), and available
  to drop into any [curated bundle](/guide/bundles).

## Keeping tools current

Re-run discovery any time (the **Re-discover tools** action on a server's detail page, or
re-`POST /register`) after the backend's spec changes. Per-tool config — guards, aliases,
enable flags — survives re-discovery.

## Removing a backend

`DELETE /admin-api/clients/:name` (see [API reference](/guide/api-reference)) removes a
backend — the registry handles in-flight request cleanup, circuit-breaker state, and
tool-index removal for you, and its persisted admin config (guards, enable flags, etc.) is
purged too. The admin UI exposes the same action from a server's detail page.

There's also a lighter `DELETE /clients/:name` at the top level: it tears down the same
in-memory/live state but leaves the client's row in SQLite untouched, so the backend can
reappear on the next DB reconciliation. Prefer `/admin-api/clients/:name` for a real,
permanent removal; the top-level route exists mainly for the health-eviction code path
internally and isn't meant as the primary way to unregister a backend by hand.

Next: **[Aggregating backends into one endpoint →](/guide/bundles)** ·
**[Connecting MCP clients →](/guide/connecting-clients)** ·
**[Guardrails & resilience →](/guide/guardrails-resilience)**
