# Connecting MCP clients

Any MCP client — Claude Desktop, Cursor, an IDE extension, or your own agent — connects
to the bridge over the Model Context Protocol. Point it at one of the four endpoints and
it sees a unified tool list.

::: tip Supported protocol version
The bridge implements **MCP protocol version `2025-06-18`**. Clients that negotiate an
older or newer version during initialization should still interoperate (the SDK handles
version negotiation), but `2025-06-18` is the version this gateway is built and tested
against — worth knowing if you hit a client-specific quirk.
:::

## Choose an endpoint

| Endpoint                      | Gives the client                       | Use when                                        |
| ----------------------------- | -------------------------------------- | ----------------------------------------------- |
| `POST /mcp`                   | Every enabled tool, from every backend | One assistant should reach everything           |
| `/mcp/:clientName`            | Only that one backend's tools          | You want to isolate a single backend            |
| `/mcp-custom/:bundleName`     | A hand-picked cross-backend subset     | You've curated exactly the tools an agent needs |
| `GET /sse` + `POST /messages` | The same tools over legacy SSE         | The client only speaks the older transport      |

Prefer **Streamable HTTP** (`/mcp`, `/mcp/:name`, `/mcp-custom/:bundle`) unless a client
requires SSE.

> **Note:** "client" is overloaded on this page — `:clientName` in a URL is the name you gave
> a **backend** at registration (e.g. `petstore`), not the app connecting to the bridge
> (Claude Desktop, Cursor, …). This doc uses "client" for both; check context. See
> [Concepts & glossary](/guide/concepts) for the full vocabulary.

## Point a client at it

Most clients take a remote MCP server URL:

```json
{
  "mcpServers": {
    "bridge": { "url": "https://bridge.example.com/mcp" }
  }
}
```

For a curated bundle, swap the URL for `https://bridge.example.com/mcp-custom/support-agent`.

Prefer not to hand-edit that JSON? `gateway connect --client cursor --scope client --name petstore`
(and friends for Claude Desktop, Windsurf, Continue) generates the same snippet from the CLI —
see [CLI reference →](/guide/cli).

## Authentication

If you've set `MCP_API_KEYS` (recommended in production), the client must present a key as
a Bearer token:

```
Authorization: Bearer <mcp-api-key>
```

Clients that support custom headers can set this directly; for others, put the bridge
behind a proxy that injects it. Keys can be **scoped** to specific clients/tools and given
an expiry — see [Access control](/guide/access-control). The bridge can also accept
**OAuth2/OIDC JWTs** as the credential when `JWT_JWKS_URL` is configured.

## Verify the connection

- `GET /health` should return `{ "status": "ok" }`.
- The client's tool list should populate after connecting; if it's empty, the client/tool
  may be disabled or the key out of scope.
- `GET /metrics` (admin-authenticated) exposes `mcp_tool_calls_total{outcome}` once calls
  start flowing.

Next: **[Registering backends →](/guide/registering-backends)** to give clients something
to call, or **[Access control →](/guide/access-control)** to scope who can call what.
