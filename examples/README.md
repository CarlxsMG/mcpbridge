# Examples

Copy-and-run samples for the two main ways to drive MCP REST Bridge — the **config-as-code
CLI** and the **`POST /register` API** — plus ready-to-paste **MCP client configs**. Every
file here matches the exact request/config shapes the gateway accepts.

```
examples/
├── gateway.yaml               # config-as-code: register backends + set guards, in one file
├── register/                  # one POST /register body per registration mode
│   ├── openapi.json           #   REST, auto-discovered from an OpenAPI spec
│   ├── curl-import.json       #   REST, derived from a pasted cURL command
│   ├── postman.json           #   REST, derived from a Postman Collection v2.1 export
│   ├── manual.json            #   REST, hand-written tool definitions
│   ├── graphql.json           #   GraphQL, introspected into one tool per query/mutation
│   └── mcp-upstream.json      #   an existing MCP server, re-exposed through the bridge
└── mcp-clients/               # drop-in client configs pointing at the gateway
    ├── claude-desktop.json
    └── cursor.json
```

## Prerequisites

- A running gateway. The quickest path is Docker — see
  [docs/guide/getting-started.md](../docs/guide/getting-started.md). The commands below assume
  it's reachable at `http://localhost:3000` (dev via `bun run dev:all` uses `:8790` instead):

  ```bash
  export BASE=http://localhost:3000
  ```

- Two different kinds of key, don't mix them up:
  - **Admin API key** (`ADMIN_API_KEYS` on the server) — authorizes `POST /register` and the
    `gateway` CLI. Export it as `ADMIN_API_KEY` for the commands below.
  - **MCP API key** (`MCP_API_KEYS`, or one created under **API keys** in the admin UI) — what
    an MCP _client_ presents when it connects to a `/mcp/...` endpoint. This is the
    `<YOUR_MCP_API_KEY>` placeholder in `mcp-clients/`.

  ```bash
  export ADMIN_API_KEY=...   # a value from the server's ADMIN_API_KEYS
  ```

## `register/` — one backend per registration mode

Each JSON file is a complete `POST /register` request body. Send one with `curl` (registration
requires admin auth, as a Bearer token):

```bash
curl -X POST "$BASE/register" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d @examples/register/openapi.json
```

Swap in any of the other files:

| File                | Mode          | Key fields in the body                                  |
| ------------------- | ------------- | ------------------------------------------------------- |
| `openapi.json`      | REST, OpenAPI | `openapi_url` (+ optional `include_tags`)               |
| `curl-import.json`  | REST, cURL    | `curl_input`                                            |
| `postman.json`      | REST, Postman | `postman_collection` (object or JSON string)            |
| `manual.json`       | REST, manual  | `base_url` + a `tools[]` array (method/endpoint/schema) |
| `graphql.json`      | GraphQL       | `kind: "graphql"` + `graphql_url`                       |
| `mcp-upstream.json` | MCP upstream  | `kind: "mcp"` + `mcp_url` + `mcp_transport`             |

`tools`, `openapi_url`, `curl_input`, and `postman_collection` are **mutually exclusive** —
a REST registration provides exactly one. Only `openapi.json` points at a real public API
(the Swagger Petstore) and works unedited; the others use `api.example.com`-style hosts, so
change the URLs to your own backend before sending. Full reference:
[docs/guide/registering-backends.md](../docs/guide/registering-backends.md).

## `gateway.yaml` — config-as-code

`gateway.yaml` both registers backends (`servers:`) and configures them — guards, guardrails,
bundles, alert rules, consumers (`config:`) — in one version-controllable file. Apply it with
the bundled CLI (run from the repo root):

```bash
bun run cli -- login --url "$BASE" --token "$ADMIN_API_KEY"   # once per machine
bun run cli -- plan  --file examples/gateway.yaml             # preview (non-zero exit on drift)
bun run cli -- apply --file examples/gateway.yaml             # register servers, then apply config
```

`apply` runs in two phases: it first registers any missing `servers:` entries via
`POST /register`, then applies the `config:` block via `POST /admin-api/config/import`. The
`config:` block is the verbatim shape of `GET /admin-api/config/export`, so the usual workflow
is `gateway pull` to snapshot a live gateway, edit, then `plan` / `apply`. The sample's
`petstore` server registers as-is; the placeholder `github` MCP upstream will fail to register
until you point `mcp_url` at a real endpoint (or remove it). See
[docs/guide/cli.md](../docs/guide/cli.md).

## `mcp-clients/` — connect an MCP client

Point an MCP client at a single backend's shard (`/mcp/:clientName`), a curated bundle
(`/mcp-custom/:bundleName`), or the `/mcp` control plane. Both samples target the `petstore`
shard on `https://bridge.example.com` — edit the URL to your gateway and replace
`<YOUR_MCP_API_KEY>` with a real MCP API key first.

- **`claude-desktop.json`** — merge into `claude_desktop_config.json` (macOS:
  `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then fully restart
  Claude Desktop. It shells out to the community `mcp-remote` bridge (via `npx`) because
  Claude Desktop's remote-connector UI has no static-header field; the API key is passed
  through the `AUTH_HEADER` env var.
- **`cursor.json`** — save as `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json`
  globally. Cursor talks Streamable HTTP directly, so it just needs `url` + `headers`.

You can generate the equivalent snippet for these and other clients (Windsurf, Continue, a
generic `url`+`headers` shape) with `bun run cli -- connect --client <id> --scope client --name petstore`.
Details: [docs/guide/connecting-clients.md](../docs/guide/connecting-clients.md).
