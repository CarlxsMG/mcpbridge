---
layout: home
title: The self-hosted MCP gateway with a real admin UI
titleTemplate: MCP REST Bridge

hero:
  name: MCP REST Bridge
  text: Any REST, GraphQL or MCP server → secure, governed AI tools
  tagline: The self-hosted MCP gateway with a real admin UI. Auto-discover tools from OpenAPI, GraphQL, a cURL command or a Postman export — or aggregate other MCP servers. Per-tool guardrails, RBAC and circuit breaking in one binary. No Kubernetes.
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
  - icon:
      src: /icons/connect.svg
      width: 28
      height: 28
      wrap: true
    title: Connect anything
    details: Auto-discover tools from an OpenAPI or GraphQL spec, a cURL command or a Postman export — or re-expose an existing MCP server. REST, GraphQL and MCP-to-MCP in one gateway.
  - icon:
      src: /icons/dashboard.svg
      width: 28
      height: 28
      wrap: true
    title: A real admin UI
    details: Not a pile of YAML. A full Vue 3 dashboard for servers, tool bundles, keys, usage, alerts, schedules and the audit log.
  - icon:
      src: /icons/shield.svg
      width: 28
      height: 28
      wrap: true
    title: Secure by default
    details: SSRF + DNS-rebinding protection with IP pinning, prompt-injection sanitizing, secret detection and fail-closed per-tool key restrictions — built in, not a plugin.
  - icon:
      src: /icons/sliders.svg
      width: 28
      height: 28
      wrap: true
    title: Per-tool governance
    details: Rate limits, timeouts, circuit breakers and allowed-key rules on any single tool. RBAC (admin / operator / auditor / viewer) plus team multi-tenancy.
  - icon:
      src: /icons/activity.svg
      width: 28
      height: 28
      wrap: true
    title: Observable & auditable
    details: Prometheus /metrics, OpenTelemetry tracing per call, usage-anomaly alerts, and a tamper-evident hash-chained audit log with SIEM streaming.
  - icon:
      src: /icons/server.svg
      width: 28
      height: 28
      wrap: true
    title: Runs anywhere
    details: Bun single process with bun:sqlite storage. No external database, no Kubernetes. One Docker image, or `bun src/index.ts`.
---

## See it in action

The whole bridge is managed from a built-in dashboard — register backends, curate what
each client sees, and watch health, usage and audit trails live.

<DemoReel />

> 🎮 **[Try the live demo →](https://aico-dot-team-code.github.io/mcpbridge/demo/)** — the real
> admin UI running on mock data, right in your browser. No install, no signup.

<ConvertAnything />

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
MCP client at that backend's shard — `http://localhost:3000/mcp/<your-server>` — or
[curate a bundle](/guide/bundles) to serve several backends behind one endpoint. Full
walkthrough in **[Getting started →](/guide/getting-started)**

## How it works

<HowItWorks />

Serve backend tools two ways: **per-client** `/mcp/:name` for one backend, or a **curated
bundle** `/mcp-custom/:bundle` to put several behind one endpoint. The `/mcp` root is the
**control plane** — `sys_*` tools an agent uses to operate the gateway itself, not backend
tools. ([How bundles aggregate several backends →](/guide/bundles))

## Why teams pick it

- **The UI is the product.** Most open-source MCP gateways are config-file only. This one
  ships a dashboard you'd actually hand to a teammate.
- **One tool, both directions.** Bridge REST APIs _and_ aggregate MCP servers behind a
  single governed endpoint.
- **Security isn't an add-on.** SSRF, injection sanitizing and secret detection are on by
  default, on every path.
- **No heavy infra.** No Kubernetes, no Postgres, no sidecars. A binary and a SQLite file.
- **Tested for real.** 280+ backend test files, Vitest, Playwright e2e and Stryker mutation
  testing — coverage that measures whether the tests catch bugs, not just run lines.

<div style="margin-top: 2.5rem; text-align: center;">

**[Get started in 60 seconds →](/guide/getting-started)** &nbsp;·&nbsp;
**[⭐ Star on GitHub](https://github.com/aico-dot-team-code/mcpbridge)**

</div>
