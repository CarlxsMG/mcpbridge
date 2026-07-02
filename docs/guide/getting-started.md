# Getting started

MCP REST Bridge turns your REST APIs and existing MCP servers into a single, governed set
of MCP tools — managed from a built-in admin UI. This guide gets you from zero to a running
bridge with a registered backend in a few minutes.

## Prerequisites

- [Bun](https://bun.sh) `1.x` (the bridge uses Bun's built-ins — `bun:sqlite`, `Bun.dns`,
  `Bun.password` — so Node.js is not a substitute), **or** Docker.
- An OpenAPI/Swagger URL for a REST API, or the URL of an existing MCP server.

## Option A — Docker (fastest)

```bash
docker build -t mcpbridge .

docker run -p 3000:3000 \
  -e NODE_ENV=development \
  -e SESSION_COOKIE_SECURE=false \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-min-12-chars \
  -v "$PWD/data:/app/data" \
  mcpbridge
```

Then open **http://localhost:3000/admin** and log in with the bootstrap credentials.

::: warning Local HTTP only
`NODE_ENV=development` and `SESSION_COOKIE_SECURE=false` relax the startup guards so the
session cookie works over plain `http://localhost`. **In production, serve over HTTPS and
drop both** — the cookie then becomes `__Host-`/`Secure` automatically.
:::

## Option B — Bun (local dev, hot reload)

```bash
bun install
cp .env.example .env                 # then set BOOTSTRAP_ADMIN_PASSWORD (min 12 chars)
cd admin-ui && bun install && cd ..

bun run dev:all                      # backend :8790 + admin UI :8791
```

Open **http://localhost:8791/admin/** and log in.

The bootstrap admin is created **only once**, while the users table is empty. After that
these env vars are ignored and you manage users from the UI.

## Register a REST API (auto-discovered from OpenAPI)

The easy path: in the UI, go to **Add server → REST**, paste an OpenAPI URL, and submit —
the bridge fetches the spec, generates one MCP tool per operation, and starts health-checking
the backend.

Or via the API (needs an admin API key — set `ADMIN_API_KEYS` and send it as a Bearer token):

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'
```

You can also `include_tags` / `exclude_operations` to select exactly which operations become
tools, or pass a manual `tools` array instead of `openapi_url` when there's no spec.

## Register an existing MCP server as an upstream

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

The bridge connects to the upstream, discovers its tools, and re-exposes them through the
same guard stack as everything else. Both `streamable-http` and `sse` upstream transports
are supported.

## Connect an MCP client

Point any MCP client (Claude Desktop, Cursor, your own agent) at the aggregated endpoint:

```json
{
  "mcpServers": {
    "bridge": { "url": "http://localhost:3000/mcp" }
  }
}
```

Four serving modes are available:

| Mode | Endpoint | Use it for |
|---|---|---|
| Aggregated | `/mcp` | Everything registered, one endpoint |
| Per-client shard | `/mcp/:clientName` | Only one backend's tools |
| Curated bundle | `/mcp-custom/:bundleName` | A hand-picked cross-backend subset |
| Legacy SSE | `/sse` + `/messages` | Older MCP clients |

## Next steps

- **[Features →](/guide/features)** — the full capability list (guardrails, RBAC, canary,
  tracing, audit, and more).
- **[Why MCP REST Bridge →](/guide/why-mcp-rest-bridge)** — how it compares and where it fits.
- Lock things down for production: set `MCP_API_KEYS`, configure per-tool guardrails, and
  serve behind HTTPS.
