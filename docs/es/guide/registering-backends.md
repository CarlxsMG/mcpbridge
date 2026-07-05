# Registering backends

A backend is a **REST API**, a **GraphQL API**, or an existing **MCP server** — each turned
into (or re-exposing) MCP tools through the same guard stack. Register from the admin UI
(**Add server**) or the `POST /register` API. Registration requires admin auth — a session,
or an `ADMIN_API_KEYS` Bearer token.

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

Or point `postman_collection` at a Postman Collection v2.1 export (as a JSON string) to derive
one tool per request in the collection — useful when a team already maintains one instead of
an OpenAPI spec.

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
- **Tools go live** across all four serving modes immediately.

## Keeping tools current

Re-run discovery any time (the **Re-discover tools** action on a server's detail page, or
re-`POST /register`) after the backend's spec changes. Per-tool config — guards, aliases,
enable flags — survives re-discovery.

## Removing a backend

`DELETE /clients/:name` (admin auth) unregisters a backend — the registry handles in-flight
request cleanup, circuit-breaker state, and tool-index removal for you. The admin UI exposes
the same action from a server's detail page.

Next: **[Connecting MCP clients →](/guide/connecting-clients)** ·
**[Guardrails & resilience →](/guide/guardrails-resilience)**
