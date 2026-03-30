```markdown
# test-1 — MCP Micro-Proxy / REST Bridge

A lightweight MCP server that acts as a translator bridge between AI clients (via MCP/SSE protocol) and legacy REST APIs. It exposes any registered REST API as native MCP tools to the LLM, without requiring any changes to the original backends.

---

## Quick Start

```bash
# Install dependencies
bun install

# Run the server
bun run index.ts
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh/) |
| HTTP Server | Express (via Bun) |
| AI Protocol | MCP — Model Context Protocol (SSE transport) |
| Client Communication | REST (HTTP GET / POST via `fetch()`) |
| Message Format | JSON-RPC 2.0 |

---

## Key Rules

- **This server does NO heavy processing.** Its sole responsibility is protocol translation: MCP ↔ REST.
- **Never modify registered client APIs.** The proxy adapts to them, not the other way around.
- **All registered client IPs are captured automatically** at registration time from the incoming request.
- **Health checks are mandatory.** Every registered client must provide a `health_url`; the proxy polls it continuously.
- **Keep memory footprint minimal.** The entire server should consume only a few MB of RAM.
- **SSE connection must remain open** for the duration of an AI session — do not close prematurely.

---

## Patterns & Conventions

### Client Registration (`POST /register`)
Each REST client self-registers by calling this endpoint. The payload must include:

```json
{
  "name": "my-api",
  "tools": [
    {
      "name": "get_customer",
      "method": "GET",
      "endpoint": "/customers/:id",
      "description": "Fetch a customer by ID"
    }
  ],
  "health_url": "http://<client-ip>/health"
}
```

- `ip` is **not** provided by the client — it is extracted server-side from the request.
- `tools` is a list of endpoint descriptors that will be converted into MCP tools.

### Operational Flow (Linear)
```
LLM → JSON-RPC command (MCP/SSE)
  → Proxy extracts params
    → fetch() to registered REST API
      → REST JSON response
        → Proxy wraps in MCP format
          → Push back to LLM via SSE
```

### Client Registry Management
- Maintain an in-memory map of registered clients: `name → { ip, tools, health_url, status }`.
- Run periodic health checks against each client's `health_url`.
- Mark clients as `healthy` / `unreachable` based on health check results.
- Expose the following introspection endpoints for LLM discovery:
  - `GET /clients` — list all registered clients and their status.
  - `GET /clients/:name/tools` — list tools for a specific client.

### MCP Tool Naming Convention
- Tool names should follow `snake_case`.
- Prefix with client name when exposing to MCP to avoid collisions: `<client_name>__<tool_name>` (e.g., `crm__get_customer`).

### Error Handling
- If a downstream REST call fails, wrap the error in a valid MCP error response — never crash the SSE connection.
- If a client is `unreachable`, return a descriptive MCP error immediately without attempting the fetch.
```