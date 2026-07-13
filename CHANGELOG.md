# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Comprehensive Stryker mutation-testing coverage across the entire backend, used as a
  regression-detection backstop for the test suite — every file with meaningful runtime logic
  is now effectively 100% mutation-killed (`bun run test:mutate`).
- W3C `traceparent` context propagation: the gateway now honors an incoming `traceparent` on
  MCP requests (its own OTLP span inherits the caller's trace-id and records the upstream's
  span-id as its parent) and injects a matching `traceparent`/`tracestate` on every outbound
  call to backends and MCP upstreams. Implementation lives in
  `src/observability/trace-context.ts`, plumbed through `requestIdMiddleware`.
- `docs/architecture/slos.md` — a public reliability contract (4 percentage-window SLOs + 2
  binary SLOs, grounded in the real Prometheus metric names, with a standard 4-window
  burn-rate alert template) — plus 4 ADRs in `docs/architecture/decisions/` documenting the
  `/mcp` control/data-plane split, traceparent propagation, the SLO contract, and e2e-as-CI-gate.
- E2E coverage expansion: new `e2e/auth-fail-closed.spec.ts` (MCP data-plane auth lockdown once
  a managed key is minted) and `e2e/mcp-protocol.spec.ts` (protocol-contract assertions on
  `/mcp/:clientName`) Playwright specs, wired into a new required `e2e` CI job that runs the
  full suite on every PR/push to `main`.

### Changed

- Internal test-suite cleanup: co-located ~113 test files with their source under
  `src/<feature>/__tests__/`, and added a shared `withConfig()` test helper to remove
  repeated untyped config-mutation boilerplate from test setup/teardown.
- Documentation: closed 12 feature/doc gaps found by a features-vs-docs audit (bundle install
  links, the install catalog, tool tags, the context-budget guard, admin-UI SSO login,
  self-service session/password management, the on-demand backup endpoint, audit-log export
  formats, dedicated WebSocket proxy targets, CORS/Origin/JSON-depth defenses, and the widget
  dashboard), corrected two inaccurate claims in `docs/guide/scaling.md` (load balancing is
  per-client, not per-tool; the health-check/auto-eviction loop is leader-gated too), and
  updated `CONTRIBUTING.md`'s stale "no linter configured" section.

### Fixed

- **Security:** the startup "Active configuration" log line no longer leaks
  `SECRET_ENCRYPTION_KEY` or `VAULT_TOKEN` in plaintext — both are now redacted the same way
  admin/MCP API keys and the bootstrap password already were.
- **Security:** `.github/workflows/security.yml`'s `bun audit` gate was previously
  report-only (`|| true`) and silently accumulated vulnerabilities with none blocking CI. The
  gate now fails on high/critical findings (`bun audit --audit-level=high`). Resolved 24 of 25
  root advisories (mainly via an `@modelcontextprotocol/sdk` bump) and all 5 admin-ui advisories
  (a critical `vitest` arbitrary file read/exec, fixed by bumping to `^3.2.7`); one moderate `qs`
  DoS advisory remains, nested under `express`/`@stryker-mutator/core` with no upstream fix yet.
- `scripts/check-all.ts` now strips `SECRET_ENCRYPTION_KEY` before spawning the root test
  process, matching the existing `SESSION_COOKIE_SECURE` handling.
- `e2e/smoke.spec.ts` now targets stable `#preview-table`/`#tools-table` ids instead of the
  CSS classes removed by the admin-ui reusability refactor.

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
