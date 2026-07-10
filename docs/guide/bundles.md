# Aggregating backends into one endpoint (bundles)

Register two backends — say a `petstore` REST API and a `github` MCP upstream — and each one
gets its own shard: `/mcp/petstore`, `/mcp/github`. But an agent usually wants **a few tools
from several backends in one place** — not one backend at a time, and not _everything_
flattened together either.

That's a **bundle**: an admin-curated, cross-backend subset of tools (plus optional
[composite macros](/guide/features)) served on its own MCP endpoint at
`/mcp-custom/:bundleName`. It's how you turn _several_ REST APIs and MCP servers into _one_
governed MCP endpoint.

::: tip Why not just point an agent at `/mcp`?
`/mcp` is the [control plane](/guide/architecture) — `sys_*` tools for managing the gateway
itself, not backend tools. There is deliberately **no** "every backend tool, flattened"
endpoint (it made API keys, RBAC and each bundle's tool surface ambiguous — see
[ADR-0001](https://github.com/aico-dot-team-code/mcpbridge/blob/main/docs/architecture/decisions/0001-two-planes-three-endpoints.md)).
A bundle gives you exactly the cross-backend surface you meant, and nothing else.
:::

## 1. Register the backends

Each backend is registered once, the usual way (see
[Registering backends](/guide/registering-backends)):

```bash
# a REST API, auto-discovered from its OpenAPI spec
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'

# an existing MCP server, re-exposed through the same guard stack
curl -X POST https://bridge.example.com/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

## 2. Curate a bundle across both

Pick the exact tools you want from each backend. A bundle entry is `{ client, tool }` — the
backend's registered name plus the **bare** tool name (not the `client__tool` namespaced
form):

```bash
curl -X POST https://bridge.example.com/admin-api/bundles \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "support-agent",
    "description": "The read-only tools a support agent needs, across pets and issues",
    "tools": [
      { "client": "petstore", "tool": "getPetById" },
      { "client": "github",   "tool": "search_issues" }
    ]
  }'
```

- `name` must match `^[a-z0-9][a-z0-9_-]{0,62}$` — it becomes the URL path segment.
- Every `{ client, tool }` must reference a tool that actually exists, or the whole call
  fails with `400` — there are no half-created bundles.
- Creating a bundle needs the **admin** role (an admin session with its `X-CSRF-Token`, or an
  `ADMIN_API_KEYS` Bearer token).
- Adding a tool to a bundle never copies or forks it: the tool still lives on its backend, and
  every call still runs through the full guard stack (SSRF → guardrails → per-tool policy →
  circuit breaker → dispatch → audit), exactly as if it were called on its own shard.

Prefer the UI? **Bundles → New bundle** gives you a searchable, cross-client tool picker that
writes the same payload for you.

## 3. Connect to the one endpoint

The bundle is live at `/mcp-custom/support-agent` immediately. Point any MCP client there and
it sees exactly those two tools — from two _different_ backends — as one unified tool list:

```json
{
  "mcpServers": {
    "support-agent": { "url": "https://bridge.example.com/mcp-custom/support-agent" }
  }
}
```

Or generate the client config with the CLI instead of hand-editing it:

```bash
gateway connect --client cursor --scope bundle --name support-agent
```

## Going further

- **[Composite / macro tools](/guide/features)** — add a `composites: ["..."]` array to the
  bundle to expose a multi-step workflow (each step through the full guard stack) as a single
  callable tool. Composites are only reachable through a bundle that lists them.
- **[Bundle install links](/guide/features)** — mint a shareable, revocable one-click link
  that auto-provisions a bundle-scoped MCP key, so end users never handle a raw key.
- **[Access control](/guide/access-control)** — scope an MCP API key to a bundle so a caller
  can reach _only_ that curated surface, nothing else on the gateway.

Next: **[Connecting MCP clients →](/guide/connecting-clients)** ·
**[Access control →](/guide/access-control)**
