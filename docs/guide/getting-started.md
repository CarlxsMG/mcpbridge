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

export ADMIN_API_KEY=$(openssl rand -hex 24)

docker run -p 3000:3000 \
  -e NODE_ENV=development \
  -e SESSION_COOKIE_SECURE=false \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-min-12-chars \
  -e ADMIN_API_KEYS=$ADMIN_API_KEY \
  -v "$PWD/data:/app/data" \
  mcpbridge
```

Then open **http://localhost:3000/admin** and log in with the bootstrap credentials.
`$ADMIN_API_KEY` is the Bearer token the `curl` examples below use — keep it exported in the
same shell, or re-export it later with the same value.

::: warning Local HTTP only
`NODE_ENV=development` and `SESSION_COOKIE_SECURE=false` relax the startup guards so the
session cookie works over plain `http://localhost`. **In production, serve over HTTPS and
drop both** — the cookie then becomes `__Host-`/`Secure` automatically.
:::

::: tip Prefer not to build from source?
Every release publishes a prebuilt, multi-arch, signed image — drop the `docker build` and
use `ghcr.io/aico-dot-team-code/mcpbridge:latest` as the image in `docker run`. See
[Deployment →](/guide/deployment).
:::

## Option B — Bun (local dev, hot reload)

```bash
bun install
cp .env.example .env                 # then set BOOTSTRAP_ADMIN_PASSWORD (min 12 chars)
cd admin-ui && bun install && cd ..

bun run dev:all                      # backend :8790 + admin UI :8791
```

::: tip Why different ports than the Docker example above?
Dev mode deliberately uses high, uncommon ports (8790/8791) instead of the Docker/production
default of 3000, so a local dev server doesn't clash with 3000 — or with a real gateway
instance you might also be running locally. Both are configurable (`PORT`, `UI_PORT` in
`.env`) — see [Configuration →](/guide/configuration).
:::

Open **http://localhost:8791/admin/** and log in.

The bootstrap admin is created **only once**, while the users table is empty. After that
these env vars are ignored and you manage users from the UI.

Set `ADMIN_API_KEYS` in `.env` (e.g. `ADMIN_API_KEYS=$(openssl rand -hex 24)`), restart
`bun run dev:all`, then export the same value as `$ADMIN_API_KEY` for the `curl` examples below.

::: tip Every command below assumes Option A's port
The examples use `http://localhost:3000` (Docker/Option A). On **Option B**, the backend is on
`:8790` instead — set `export BASE=http://localhost:8790` and swap `$BASE` in for
`http://localhost:3000`, or just replace the port by hand.
:::

## Register a REST API (auto-discovered from OpenAPI)

The easy path: in the UI, go to **Add server → REST**, paste an OpenAPI URL, and submit —
the bridge fetches the spec, generates one MCP tool per operation, and starts health-checking
the backend.

Or via the API (needs the admin API key you set above, sent as a Bearer token):

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

Point any MCP client (Claude Desktop, Cursor, your own agent) at a **backend shard** — one
registered backend's tools. For the `petstore` you just registered, that's `/mcp/petstore`.
The bridge implements **MCP protocol version `2025-06-18`** — see
[Connecting MCP clients →](/guide/connecting-clients) for details on version negotiation.

```json
{
  "mcpServers": {
    "petstore": { "url": "http://localhost:3000/mcp/petstore" }
  }
}
```

(`:8790` instead of `:3000` if you're on Option B.)

Three endpoints, two planes:

| Endpoint                  | Plane   | Gives the client                                                               |
| ------------------------- | ------- | ------------------------------------------------------------------------------ |
| `/mcp/:clientName`        | data    | One backend's tools (e.g. `/mcp/petstore`)                                     |
| `/mcp-custom/:bundleName` | data    | A curated cross-backend subset — [several behind one endpoint](/guide/bundles) |
| `POST /mcp`               | control | `sys_*` tools to operate the gateway itself, **not** backend tools             |

Transport is **Streamable HTTP** on every endpoint (the legacy SSE transport was removed).

::: tip Want one endpoint that exposes `petstore` _and_ an upstream together?
That's a **bundle** — see [Aggregating backends into one endpoint →](/guide/bundles).
:::

## Next steps

- **[Features →](/guide/features)** — the full capability list (guardrails, RBAC, canary,
  tracing, audit, and more).
- **[Why MCP REST Bridge →](/guide/why-mcp-rest-bridge)** — how it compares and where it fits.
- Lock things down for production: set `MCP_API_KEYS`, configure per-tool guardrails, and
  serve behind HTTPS.
