# Changelog

Mirrors the repo's root [`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md)
so it's searchable alongside the rest of the docs. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). For the full commit-level
history, see [GitHub Releases →](https://github.com/aico-dot-team-code/mcpbridge/releases).

## [Unreleased]

Since 1.0.0, the backend has picked up comprehensive Stryker mutation-testing coverage (every
file with meaningful runtime logic is now effectively 100% mutation-killed), plus a handful of
real user- and operator-facing changes: W3C `traceparent` propagation through the proxy pipeline, a public
[SLO reliability contract](/architecture/slos), expanded Playwright e2e coverage gated in CI, and
a security fix so the startup config log no longer leaks `SECRET_ENCRYPTION_KEY`/`VAULT_TOKEN` in
plaintext.

Several rounds of security hardening followed: a **Docker image build break (P0)** that stopped
every container image from building at all; a **team-tenancy escape** where a team-scoped admin
could reach global routes (user CRUD, DB backup, config export/import) meant for super-admins
only; a **prototype-pollution guard** on every tool dot-path writer/reader, unified behind one
hardened `src/lib/object-path.ts`; a requirement that inbound **JWT auth set `JWT_AUDIENCE`**,
closing a cross-audience token-reuse gap; a **permanent MCP session-capacity leak (DoS)** where a
session-less non-`initialize` POST never released its reservation; a **circuit-breaker half-open
probe leak** that could permanently wedge a recovering client; uniform response sanitization
across REST/MCP-upstream/WebSocket success **and** error paths; actual IP-pinning for WebSocket
dials (Bun's `ws` shim silently ignored the old DNS-rebinding guard); and a JWKS refetch on an
unrecognized `kid` so a routine IdP key rotation no longer locks out JWT/SSO auth. Operationally:
the Helm/Docker health probes now point at the purpose-built `/livez` (liveness) and `/readyz`
(readiness, leader-gated) endpoints instead of the legacy always-200 `/health`; the CLI gained a
top-level `--help`/`--version`; a runnable `examples/` directory ships sample configs and
`/register` bodies for every registration mode; `monitoring/` ships deployable Prometheus alert
rules and a Grafana dashboard for the SLOs; and the admin UI got a coverage-ratchet gate plus a
round of accessibility fixes (ARIA tabs keyboard model, focus management, translated error
strings).

Most recently: a **P0 fix** closed an MCP `resources`/`prompts` bypass where a managed key
restricted to one client could still read another client's resources and prompts through the
shared `/mcp/:clientName` route (that content is now also guardrail-scanned and credential-stripped
like tool results); a **P1 fix** broadened the IPv4 SSRF blocklist to cover several reserved ranges
the IPv6 path already blocked; and a **P1 fix** made the compiled per-tool schema-validator cache
invalidate on re-registration, so tightening a tool's `inputSchema` no longer keeps enforcing the
old, looser schema until a process restart. Alongside those: a handful of admin-UI correctness
fixes (pagination `Prev` getting stuck before page one, a mislabeled AlertsPage column, a
stale-filter URL-sync bug, a missing unsaved-changes guard), a CLI fix so a non-JSON admin-API
response raises a proper `CliApiError` instead of a raw parse error, CI smoke tests that actually
boot the Docker image and release binaries before publishing, and several documentation
corrections (health-probe/load-balancer routing guidance, IP-pin re-resolution behavior, the
OpenAPI canary-weight range). See the root
[`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md#unreleased)
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
