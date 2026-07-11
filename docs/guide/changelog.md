# Changelog

Mirrors the repo's root [`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md)
so it's searchable alongside the rest of the docs. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). For the full commit-level
history, see [GitHub Releases →](https://github.com/aico-dot-team-code/mcpbridge/releases).

## [Unreleased]

Since 1.0.0, the backend has picked up comprehensive Stryker mutation-testing coverage (every
file with meaningful runtime logic is now effectively 100% mutation-killed — see
[`MUTATION_TESTING_LOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/MUTATION_TESTING_LOG.md)
in the repo root for the full per-file engineering log), plus a handful of real user- and
operator-facing changes: W3C `traceparent` propagation through the proxy pipeline, a public
[SLO reliability contract](/architecture/slos), expanded Playwright e2e coverage gated in CI, and
a security fix so the startup config log no longer leaks `SECRET_ENCRYPTION_KEY`/`VAULT_TOKEN` in
plaintext. See the root [`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md#unreleased)
for the full curated list.

## [1.0.0] - 2026-07-03

Initial tagged release of **MCP REST Bridge** — a self-hosted MCP gateway that turns
REST APIs (via OpenAPI/Swagger auto-discovery) and existing MCP servers into secure,
governed AI tools, with a built-in Vue admin UI instead of a pile of YAML. Everything
below shipped incrementally on `main` and is being released together as `1.0.0`.

### Highlights

- **Core gateway.** OpenAPI/Swagger-to-MCP auto-discovery and registration, MCP-to-MCP
  passthrough registration, sharded MCP endpoint, and a canonical request/response
  envelope across both transports.
- **Security by default.** SSRF and DNS-rebinding protection with upstream IP pinning,
  strict CORS allowlisting, hashed session/auth comparisons, encrypted upstream secrets
  (`secret-box`), prompt-injection sanitizing, and refuse-to-start guards for unsafe
  configuration (e.g. `AUTH_DISABLED` outside dev, wildcard CORS).
- **Resilience.** Per-client circuit breakers with sliding-window failures and atomic
  half-open probes, per-tool rate limiting with LRU-bounded buckets, retry with
  isolated abort signals and HTTP-date `Retry-After` handling, and resilient health
  polling with drain-aware shutdown.
- **Observability.** Prometheus exposition for breaker/rate-limiter/proxy/health
  metrics, OTLP tracing, a trace viewer, usage-anomaly detection, and a tamper-evident,
  hash-chained audit log with SIEM streaming.
- **Admin persistence & guards.** SQLite-backed (`bun:sqlite`) persistent config for
  clients, tools, and guards, dynamic per-client/per-tool guard overrides, and
  config versioning/rollback.
- **Admin UI.** A full Vue 3 + Vite admin UI (dashboard, traffic, monitors, approvals,
  observability, reusable SVG charts) covering registration, guardrails, RBAC, teams,
  schedules, and canary/failover — replacing hand-edited YAML.
- **Governance & enterprise features.** RBAC, multi-tenant teams, tool aliases,
  composites, a searchable tool catalog, a playground, multi-level approvals,
  policy-as-code (YAML), schema-drift alerts, and per-end-user rate limits.
- **Protocol/proxy features.** GraphQL discovery, WebSocket passthrough (including
  persistent connections), MCP progress/cancel support, request coalescing,
  auto-quarantine of misbehaving upstreams, and a CLI for scripted management.
- **Docs & site.** A VitePress-based documentation and marketing site with an
  interactive, mock-backed admin UI demo, published via GitHub Pages.

Next: **[Contributing →](/guide/contributing)** · **[Security policy →](/guide/security-policy)**
