# Connecting MCP clients

Any MCP client — Claude Desktop, Cursor, an IDE extension, or your own agent — connects
to the bridge over the Model Context Protocol. Point it at the endpoint that matches the
tools it should see.

::: tip Supported protocol version
The bridge negotiates the MCP protocol version via the official TypeScript SDK, which
supports `2024-10-07` through `2025-11-25` and defaults to `2025-03-26` when a client sends none. Clients
that negotiate a version in that range during initialization should interoperate
automatically — worth knowing if you hit a client-specific quirk.
:::

## Choose an endpoint

The bridge exposes **three endpoints across two planes**. To give an agent your backend
tools, use one of the two **data-plane** endpoints:

| Endpoint                  | Gives the client                   | Use when                                                                        |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `/mcp/:clientName`        | Only that one backend's tools      | You want a single backend (e.g. `/mcp/petstore`)                                |
| `/mcp-custom/:bundleName` | A hand-picked cross-backend subset | You've curated exactly the tools an agent needs — [build one →](/guide/bundles) |

There is no "everything, flattened together" endpoint: to expose several backends through
one URL, [curate a bundle](/guide/bundles). The third endpoint is the **control plane**:

| Endpoint    | Gives the client                                            | Use when                                   |
| ----------- | ----------------------------------------------------------- | ------------------------------------------ |
| `POST /mcp` | `sys_*` tools to manage the gateway — **not** backend tools | An agent should operate the gateway itself |

> **Note:** `POST /mcp` does **not** accept a plain `MCP_API_KEYS` credential — see
> [Authentication](#authentication) below for what it actually requires.

Every endpoint speaks **Streamable HTTP** (the legacy `GET /sse` + `POST /messages`
transport was removed).

> **Note:** "client" is overloaded on this page — `:clientName` in a URL is the name you gave
> a **backend** at registration (e.g. `petstore`), not the app connecting to the bridge
> (Claude Desktop, Cursor, …). This doc uses "client" for both; check context. See
> [Concepts & glossary](/guide/concepts) for the full vocabulary.

## Point a client at it

Most clients take a remote MCP server URL — point it at a backend shard:

```json
{
  "mcpServers": {
    "petstore": { "url": "https://bridge.example.com/mcp/petstore" }
  }
}
```

For a curated bundle, swap the URL for `https://bridge.example.com/mcp-custom/support-agent`;
to operate the gateway itself, use `https://bridge.example.com/mcp`.

Prefer not to hand-edit that JSON? `gateway connect --client cursor --scope client --name petstore`
(and friends for Claude Desktop, Windsurf, Continue) generates the same snippet from the CLI —
see [CLI reference →](/guide/cli).

## Authentication

If you've set `MCP_API_KEYS` (recommended in production), the client must present a key as
a Bearer token:

```http
Authorization: Bearer <mcp-api-key>
```

Clients that support custom headers can set this directly; for others, put the bridge
behind a proxy that injects it. Keys can be **scoped** to specific clients/tools and given
an expiry — see [Access control](/guide/access-control). The bridge can also accept
**OAuth2/OIDC JWTs** as the credential when `JWT_JWKS_URL` is configured.

This applies to the two **data-plane** endpoints only. `POST /mcp` (the control plane) has
its own fail-closed check (`resolveSystemRole`) that never consults `MCP_API_KEYS`/JWTs at
all: it only accepts the `ADMIN_API_KEYS` env Bearer, or a managed key with a **system
role** (`adminRole`) set — mintable from the admin UI's Keys page. An ordinary
`MCP_API_KEYS` key, or a managed key with no `adminRole`, is rejected outright against
`/mcp` even though it works fine against `/mcp/:clientName` or `/mcp-custom/:bundleName`.

## Verify the connection

- `GET /health` should return `{ "status": "ok" }`.
- The client's tool list should populate after connecting; if it's empty, the client/tool
  may be disabled or the key out of scope.
- `GET /metrics` (admin-authenticated) exposes `mcp_tool_calls_total{outcome}` once calls
  start flowing.

Next: **[Registering backends →](/guide/registering-backends)** to give clients something
to call, or **[Access control →](/guide/access-control)** to scope who can call what.
