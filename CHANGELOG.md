# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **P2-1 — Stryker mutation testing baseline** for `src/security/compare.ts`
  (the constant-time string-compare primitive used by every secret check in
  the codebase — API keys, session tokens, CSRF tokens, guard-restricted API
  key hashes). The wrapper at `scripts/stryker-test-runner.ts` runs the test
  suite from inside the per-mutant sandbox and streams its ~7 MB of output
  to a file via `Bun.spawn` instead of `child_process.exec`, working around
  Node's hard-coded 1 MB `maxBuffer` that would otherwise kill the child
  with SIGTERM and surface as `ConfigError: There were failed tests in the
  initial test run` despite a green 1227/0 suite. Initial run on
  2026-07-06: **4/6 mutants killed (66.67% mutation score)**, completed in
  3m 26s on a single worker. The two surviving mutants are real coverage
  gaps and are tracked as P2-2 follow-up work:
  - `BlockStatement` (line 16, replacement `{}`) — if the try-block is
    emptied, equal-true inputs return `undefined` instead of `true`.
  - `BooleanLiteral` (line 17, replacement `true`) — if the catch returns
    `true` instead of `false`, any error path returns "match" — a security
    hole.
  Both survive because the existing test only exercises the catch path
  (`safeCompare("short", "verylong…")` → 403, no throw). New `compare.test.ts`
  cases are needed: `(a, a) === true`, and a hex-error path that verifies
  the catch returns `false`. Run with `bun run test:mutate`.

### Docs

- Added `docs/architecture/slos.md` (and `docs/es/architecture/slos.md`) — initial
  public reliability contract: 4 percentage-window SLOs (tool call availability 99.5%,
  tool call latency p95/p99, discovery latency p99, admin API availability) and 2 binary
  SLOs (audit chain integrity, health probe coverage), each grounded in the real
  Prometheus metric names from `src/observability/metrics.ts`. Includes the standard
  4-window burn-rate alert formulation so operators can wire it into Prometheus/Grafana.
- Added `CLAUDE.md` (repo guidance for AI coding agents).
- Added 4 ADRs in `docs/architecture/decisions/`:
  - `0001-two-planes-three-endpoints.md` — the /mcp split that separates the
    control plane (sys_* tools, rootMcpAuth fail-closed) from the data plane
    shards (`/mcp/:clientName`, `/mcp-custom/:bundleName`). Commits the
    rationale behind commit `69fd8eb` so future contributors don't re-propose
    flattening /mcp.
  - `0002-w3c-traceparent-propagation.md` — the W3C trace context propagation
    through the proxy pipeline (P1-6), implemented via `AsyncLocalStorage` so
    signature churn stays at zero. Commits the rationale behind `aebe04b`.
  - `0003-slos-public-contract.md` — the six SLOs in
    `docs/architecture/slos.md`, percentage-window for throughput, binary for
    invariants like audit chain integrity, with the standard 4-window burn-rate
    alert template. Commits the rationale behind `d2e491f`.
  - `0004-e2e-as-ci-gate.md` — the auth-fail-closed and mcp-protocol e2e
    specs as hard CI gates (order-independent, each mints its own key),
    with the smoke spec updated for the /mcp split. Commits the rationale
    behind `d58fd30` + `d5ed472`.

### Added

- `withConfig(patch, fn)` test helper (P1-9) at `src/__tests__/_utils/with-config.ts`.
  Snapshots the listed fields on the live `config` singleton, applies the patch,
  runs `fn` (sync or async), and restores the originals — even when `fn` throws
  or rejects. Replaces the repeated `(config as Record<string, unknown>).X = Y`
  pattern in 50 test call sites across 13 files, removing the un-typed cast and
  guaranteeing no config mutation leaks into the next test. The remaining ~226
  occurrences in `beforeEach`/`afterEach` save/restore blocks, helper functions
  (`resetAll`, `pointAt`), and tests that re-assign the same field with different
  values mid-body are still flagged for manual migration in a follow-up.
- P1-4 co-localización de tests **cerrada**. Los 113 tests no-raíz se
  mueven de `src/__tests__/` a `src/<feat>/__tests__/` (p.ej.
  `src/__tests__/audit-chain.test.ts` → `src/admin/audit/__tests__/audit-chain.test.ts`)
  siguiendo la estructura de carpetas existente. Imports reescritos al
  depth correcto (estático, dinámico, sibling `_utils/`, y `import.meta.dir`
  paths) para que cada archivo siga resolviendo los mismos módulos desde su
  nueva ubicación. 13 tests raíz (catalog, config-*, etc.) permanecen en
  `src/__tests__/`. `_utils/with-config.ts` también se queda en
  `src/__tests__/_utils/` — los consumidores referencian la ruta larga
  explícita. Mystery test del intento previo (`openapi-discovery.test.ts`
  con `import.meta.dir, "../../tests/fixtures"`) resuelto con rewrite
  depth-aware del path. **Verified**: bunx tsc --noEmit 0 errors;
  1227/1227 backend pass; 12/12 e2e pass.
- Follow-up notes in `docs/REVIEW.md` §8 — P1-9 partial closure (226 call sites
  remain manual), P1-3 remaining flows (canary failover + bundle install e2e).
- W3C `traceparent` propagation (P1-6). The gateway now honors an incoming
  `traceparent` on MCP requests — the bridge's own OTLP span inherits the caller's
  trace-id and records the upstream's span-id as its parent — and injects a
  matching `traceparent` (plus `tracestate` pass-through) on every outbound call
  to backends, both REST (`src/proxy/proxy.ts`) and MCP upstreams
  (`src/mcp/mcp-upstream.ts`'s transport-level fetch wrapper). Implementation
  lives in `src/observability/trace-context.ts` (strict W3C parser/serializer,
  per-request AsyncLocalStorage context, with-safe `enterWith` for the current
  span) and is plumbed through `requestIdMiddleware`. OTLP spans now emit
  `parentSpanId` when present.
- E2E coverage expansion (P1-3, partial). The Playwright suite now exercises
  two more flows beyond the existing smoke test, and the new specs are
  wired into CI:
  - `e2e/auth-fail-closed.spec.ts` — the MCP data plane starts in open mode
    (no auth material), then locks down the moment a managed MCP key is
    minted via the admin API: no Authorization → 401, bogus Bearer → 403,
    the right key → 200, and a revoked key → 403. Five tests in one spec.
  - `e2e/mcp-protocol.spec.ts` — protocol-contract assertions on
    `/mcp/:clientName`: `initialize` returns a real serverInfo,
    `tools/list` advertises the discovered client__tool with the
    OpenAPI-derived name/description/inputSchema, `tools/call` for a
    known tool returns the upstream payload, and three error paths
    (unknown tool, invalid args, upstream 404) all surface as
    `isError: true` rather than dropping the session.
    The smoke test was also updated to use `/mcp/:clientName` (the data
    plane) instead of the post-`/mcp` refactor control plane, and each
    spec mints its own managed MCP key so the suite is order-independent
    and the data plane is in a known auth-required state.
- A new `e2e` job in `.github/workflows/ci.yml` runs the full Playwright
  suite on every PR and push to `main` (12 specs, ~22s). Caches
  Playwright browsers across runs via `actions/cache`, installs
  Chromium with `--with-deps` on cache miss, and uploads the
  `test-results/` + `playwright-report/` artifact on failure for
  debugging. The job depends on `test` so a broken lint/typecheck
  fails the PR before the slower browser step runs.
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
