# FAQ

Quick answers to the questions that come up before the deeper guides do. For the full
positioning story, see [Why MCP REST Bridge →](/guide/why-mcp-rest-bridge).

## Do I need Kubernetes or a separate database?

No. The bridge is a single [Bun](https://bun.sh) process with `bun:sqlite` — one binary, one
file. It runs fine inside a container orchestrator if you already have one, but nothing about
it requires Kubernetes, Postgres, or any external service. See
[Deployment →](/guide/deployment).

## Does it work with Claude Desktop, Cursor, or other MCP clients?

Yes — any client that speaks the Model Context Protocol. The bridge negotiates the protocol
version via the official TypeScript SDK, which supports `2024-10-07` through
`2025-11-25` (defaulting to `2025-03-26` when a client sends none), and is tested against Claude Desktop, Cursor, and
custom agents. The `gateway connect` CLI command generates ready-to-paste config for Claude
Desktop, Cursor, Windsurf, and Continue specifically. See
[Connecting MCP clients →](/guide/connecting-clients).

## Is there a hosted/managed version?

No — this is self-hosted, MIT-licensed open source with no managed SaaS offering or SLA. You
run it; you own the data.

## How is this different from an OpenAPI-to-MCP CLI tool?

Those tools are great for a one-shot spec-to-tools translation, but they don't manage a
running fleet — no admin UI, no per-tool policy, no audit log, no way to aggregate multiple
backends behind one governed endpoint. See the comparison table in
[Why MCP REST Bridge →](/guide/why-mcp-rest-bridge) for the fuller picture.

## Can it aggregate multiple MCP servers, not just REST APIs?

Yes — register an existing MCP server as an upstream (`kind: "mcp"`) and it's re-exposed
through the same guard stack as a REST-derived backend: same guardrails, same RBAC, same
audit log. See [Registering backends →](/guide/registering-backends). To expose tools from
several backends (REST and/or MCP) through **one** MCP endpoint, curate a
[bundle →](/guide/bundles).

## What happens if a backend goes down?

Health checks auto-evict unreachable backends, and per-client circuit breakers fail calls fast
once a backend is clearly unhealthy instead of piling up timeouts. If you've configured a
canary/failover secondary, traffic can route there automatically. See
[Guardrails & resilience →](/guide/guardrails-resilience).

## Can I manage config as code instead of clicking through the UI?

Yes — the bundled `gateway` CLI (`bun run cli`) treats configuration as a reviewable YAML
file: `pull` the live config, edit it, `plan` to preview drift, `apply` to push it. Useful for
CI/CD and GitOps-style review. See [CLI →](/guide/cli).

## How do upgrades work?

Schema migrations run automatically on startup and are forward-only — there's no automated
rollback, so back up your SQLite database before upgrading to a new version. See
[Deployment → Upgrading](/guide/deployment#upgrading).

## Can I try it without installing anything?

Yes — the **[live demo](https://aico-dot-team-code.github.io/mcpbridge/demo/)** runs the real
admin UI against mock data, right in your browser. No install, no signup.

The demo is fully localized to Spanish as well — flip the locale switcher in
**Account → Preferences → Language** and every translatable fixture string (tool descriptions,
bundle summaries, API key labels, alert names, team / policy / composite / snapshot labels,
catalog descriptions) updates in place without losing your tab state.

## What license is this?

MIT. See [`LICENSE`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/LICENSE).

## Something's not working — where do I look?

See [Troubleshooting →](/guide/troubleshooting) for the common issues (most are deliberate
safety behavior rather than bugs), or open an issue with the `request_id` from the error
response.

Next: **[Getting started →](/guide/getting-started)** · **[Contributing →](/guide/contributing)**
