# Registering backends

A backend is either a **REST API** (turned into MCP tools from its OpenAPI spec) or an
existing **MCP server** (re-exposed through the bridge). Register from the admin UI
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

| Field                                 | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `openapi_url`                         | Discover tools from a spec (mutually exclusive with `tools`) |
| `tools`                               | Provide tool definitions manually when there's no spec       |
| `base_url`                            | Override the API base (defaults to the host of `health_url`) |
| `include_tags` / `exclude_operations` | Select exactly which operations become tools                 |
| `retry_non_safe_methods`              | Allow retries on non-idempotent methods (off by default)     |

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

Next: **[Connecting MCP clients →](/guide/connecting-clients)** ·
**[Guardrails & resilience →](/guide/guardrails-resilience)**
