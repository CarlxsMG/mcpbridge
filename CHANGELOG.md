# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Docs

- Added `docs/architecture/slos.md` (and `docs/es/architecture/slos.md`) — initial
  public reliability contract: 4 percentage-window SLOs (tool call availability 99.5%,
  tool call latency p95/p99, discovery latency p99, admin API availability) and 2 binary
  SLOs (audit chain integrity, health probe coverage), each grounded in the real
  Prometheus metric names from `src/observability/metrics.ts`. Includes the standard
  4-window burn-rate alert formulation so operators can wire it into Prometheus/Grafana.
- Added `CLAUDE.md` (repo guidance for AI coding agents).
- Closed 12 documentation gaps found by a full features-vs-docs audit: bundle install links,
  the curated install catalog, tool tags, the context-budget guard, admin-UI SSO login,
  self-service session/password management, the on-demand DB backup endpoint, audit-log
  export formats, dedicated WebSocket proxy targets, CORS/Origin/JSON-depth defenses, and the
  customizable widget dashboard.
- Fixed two inaccurate claims in `docs/guide/scaling.md` (load balancing is per-client, not
  per-tool; the health-check/auto-eviction loop is leader-gated too) and updated
  `CONTRIBUTING.md`'s stale "no linter configured" section.

### Fixed

- The startup "Active configuration" log line no longer leaks `SECRET_ENCRYPTION_KEY` or
  `VAULT_TOKEN` in plaintext — both are now redacted the same way admin/MCP API keys and the
  bootstrap password already were.
- `scripts/check-all.ts` now also strips `SECRET_ENCRYPTION_KEY` before spawning the root test
  process, mirroring the existing `SESSION_COOKIE_SECURE` handling — a contributor with that var
  set locally would otherwise see the "secret box unconfigured" tests fail with no obvious cause.
- `e2e/smoke.spec.ts` asserted against `.preview-table` / `table.tools-table` CSS classes that
  no longer exist after the admin-ui reusability refactor (both tables now render through the
  shared `TableCard` component). Added stable `#preview-table` / `#tools-table` ids and updated
  the test to match — the underlying registration flow itself was never broken.

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

[Unreleased]: https://github.com/aico-dot-team-code/mcpbridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aico-dot-team-code/mcpbridge/releases/tag/v1.0.0
