---
layout: home
title: The self-hosted MCP gateway with a real admin UI
titleTemplate: MCP REST Bridge

hero:
  name: MCP REST Bridge
  text: Any REST API or MCP server → secure, governed AI tools
  tagline: The self-hosted MCP gateway with a real admin UI. OpenAPI-to-MCP auto-discovery, per-tool guardrails, RBAC and circuit breaking — in one binary. No Kubernetes.
  actions:
    - theme: brand
      text: Try the live demo ↗
      link: https://aico-dot-team-code.github.io/mcpbridge/demo/
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: ⭐ Star on GitHub
      link: https://github.com/aico-dot-team-code/mcpbridge

features:
  - icon: 🔌
    title: Connect anything
    details: Point at an OpenAPI/Swagger spec and get MCP tools instantly — or register an existing MCP server as an upstream. REST-to-MCP and MCP-to-MCP in the same gateway.
  - icon: 🖥️
    title: A real admin UI
    details: Not a pile of YAML. A full Vue 3 dashboard for servers, tool bundles, keys, usage, alerts, schedules and the audit log.
  - icon: 🛡️
    title: Secure by default
    details: SSRF + DNS-rebinding protection with IP pinning, prompt-injection sanitizing, secret detection and fail-closed per-tool key restrictions — built in, not a plugin.
  - icon: 🎛️
    title: Per-tool governance
    details: Rate limits, timeouts, circuit breakers and allowed-key rules on any single tool. RBAC (admin / operator / auditor / viewer) plus team multi-tenancy.
  - icon: 📊
    title: Observable & auditable
    details: Prometheus /metrics, OpenTelemetry tracing per call, usage-anomaly alerts, and a tamper-evident hash-chained audit log with SIEM streaming.
  - icon: 🪶
    title: Runs anywhere
    details: Bun single process with bun:sqlite storage. No external database, no Kubernetes. One Docker image, or `bun src/index.ts`.
---

## See it in action

The whole bridge is managed from a built-in dashboard — register backends, curate what
each client sees, and watch health, usage and audit trails live.

<div class="product-shot">

![MCP REST Bridge admin UI — usage analytics with per-tool and per-key breakdowns](/screenshots/demo-usage.png)

</div>

> 🎮 **[Try the live demo →](https://aico-dot-team-code.github.io/mcpbridge/demo/)** — the real
> admin UI running on mock data, right in your browser. No install, no signup.

## 60-second quickstart

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

Open **http://localhost:3000/admin**, log in, and add your first server. Then point any
MCP client at `http://localhost:3000/mcp`. Full walkthrough in
**[Getting started →](/guide/getting-started)**

## How it works

```
   AI client                 MCP REST Bridge                 Your backends
 (Claude, Cursor,      ┌───────────────────────────┐
  IDEs, agents)        │  guardrails · RBAC ·       │      ┌── REST / OpenAPI APIs
        │              │  rate limits · breakers ·  │─────▶│
        └── MCP ──────▶│  audit · IP pinning        │      └── Upstream MCP servers
                       └───────────────────────────┘
      one unified tool list          every call proxied through the full guard stack
```

Serve tools four ways: **aggregated** `/mcp`, **per-client** `/mcp/:name`, **curated
bundles** `/mcp-custom/:bundle`, or **legacy SSE** `/sse`.

## Why teams pick it

- **The UI is the product.** Most open-source MCP gateways are config-file only. This one
  ships a dashboard you'd actually hand to a teammate.
- **One tool, both directions.** Bridge REST APIs *and* aggregate MCP servers behind a
  single governed endpoint.
- **Security isn't an add-on.** SSRF, injection sanitizing and secret detection are on by
  default, on every path.
- **No heavy infra.** No Kubernetes, no Postgres, no sidecars. A binary and a SQLite file.

<div style="margin-top: 2.5rem; text-align: center;">

**[Get started in 60 seconds →](/guide/getting-started)** &nbsp;·&nbsp;
**[⭐ Star on GitHub](https://github.com/aico-dot-team-code/mcpbridge)**

</div>
