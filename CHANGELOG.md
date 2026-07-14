# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI now **lints and renders the Helm chart** (`helm lint` + `helm template`) and runs a **Windows
  test leg** (typecheck + backend/admin-ui suites on `windows-latest`) on every push/PR — the chart
  was previously only hand-checked, and CI was Linux-only despite shipping a Windows binary and the
  maintainer developing on Windows.
- CI now **builds the container image on every push/PR** (build-only, single-arch, never pushed).
  The image is the primary distribution artifact (docker-compose + Helm both consume it), yet
  `docker-publish.yml` only built it on a `v*` tag — so a `Dockerfile`/`COPY`/multi-stage break used
  to surface only after merge, when a release was cut. Mirrors the existing docs-build PR gate.
- **OpenAPI ↔ route parity gate** (`src/__tests__/openapi-route-parity.test.ts`): fails CI when a
  real `src/routes/**` route is missing from `src/openapi.yaml`, when a documented operation has no
  route behind it, or when the committed route manifest is stale. Closing the drift it found added
  14 previously-undocumented operations to the spec — `DELETE /admin-api/clients/{name}`, the five
  OIDC SSO endpoints, the four bundle install-link endpoints (incl. the public `GET /install/{token}`),
  `POST /admin-api/backup`, `GET /admin-api/audit-log/actions`, and the `/livez` + `/readyz` probes —
  expanded the per-tool config `PATCH` body from 2 to all 19 accepted keys (new `ToolConfigPatch`
  schema), and added `uptime_seconds` to `/health`.
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
- `monitoring/` — deployable Prometheus alert rules and a Grafana dashboard for the reliability
  SLOs (the multi-window burn-rate alerts from `docs/architecture/slos.md`, wired to the real
  Prometheus metric names). Covers SLO-1/2/6 today; SLO-4's metric isn't emitted yet.
- `RELEASING.md` — the maintainer runbook for cutting the first tagged, GHCR/binary-published
  release under a real repository identity.

### Changed

- Internal: the REST dispatcher's three terminal-failure exits (non-retryable error, network
  throw, retries exhausted) in `src/proxy/proxy.ts` now share one `recordFailure()` helper instead
  of hand-rolling the same metrics/breaker/log/usage/mock-fallback sequence three times — removing
  a standing drift hazard on a security-critical hot path. No behavior change (317 proxy tests).
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
- Internal refactors (no behavior change): the response-pagination loop and HTTP helpers were
  extracted out of `src/proxy/proxy.ts` into `src/proxy/pagination.ts` / `http-util.ts`;
  `register`/`registerMcp` tool validation was de-duplicated; and the admin UI retired its
  remaining unscoped-style leaks for shared primitives (scoped classes over inline styles, a
  clearer `ModalShell` `label` prop).
- Tooling: `bun run check` now enforces `typecheck:tools` and `lint:i18n` exactly like CI; the Bun
  toolchain is pinned in the `admin-ui`/`docs` sub-projects; and four completed one-shot migration
  helper scripts were removed.

### Fixed

- **Circuit breaker — half-open probe leak fixed (could permanently brick a recovering client).**
  A call that consumed the single `half_open` probe but then bailed before reaching the backend
  (argument validation, post-substitution path traversal, a failed DNS-rebind pin refresh, or an
  MCP-upstream arg-validation miss) recorded no outcome, so the probe stayed in flight forever —
  wedging the breaker in `half_open` (every later call rejected as "Probing") and never idle-evicted,
  because each rejected check refreshed `lastAccess`. A fully recovered backend stayed unreachable
  until an admin reset. A new `CircuitBreaker.releaseProbe()` releases the probe on every such early
  exit.
- **MCP sessions — permanent "Server at capacity" leak fixed (DoS).** A POST with no session header
  that wasn't a valid `initialize` (the SDK answers it without throwing and never assigns a session
  id) leaked the up-front `activeSessionCount` reservation; after `MAX_SESSIONS` such requests — a
  stray `tools/list`, a client that lost its session — the gateway rejected **all** new sessions with
  503 until restart. The no-session branch now rolls the reservation back and closes the orphan
  transport, mirroring the existing failed-`initialize` path.
- **Security — response sanitization is now uniform across every dispatch path.** Redaction, the
  guardrail response scan, and stripping of the gateway's own injected upstream credential run
  identically on REST success **and** 4xx/5xx error bodies, MCP-upstream success **and** error
  results, and WebSocket results. Previously an error branch or the MCP-upstream path could reflect
  an injected `Authorization` (or a secret at a configured redaction path) back to a caller trusted
  to CALL the tool but not to HOLD the credential — which traffic capture then persisted.
- **Security — inbound JWT auth now requires `JWT_AUDIENCE`.** JWT bearer validation refuses a token
  when no audience is configured (and startup fails if it's missing while JWT auth is enabled),
  closing a cross-audience token-reuse gap; documented as a production startup requirement.
- **Security — least-privilege & secret-redaction hardening.** The client-shard `tools/list` is
  filtered by the calling key's scope; traffic-explorer reads require operator+; writing upstream
  OAuth config requires admin (matching bearer/basic); logger secret redaction recurses into nested
  values and covers CSRF tokens; captured-traffic args have configured redaction paths stripped; the
  startup config log gained a generic-secret fallback; the audit hash-chain pre-image is now
  injective; and catastrophic-backtracking (ReDoS) deny patterns are rejected at **every** config
  boundary — config import, rollback, and the config-as-code CLI, not only the interactive admin
  route (a persisted ReDoS pattern on the guardrail hot path could otherwise pin a CPU core).
- **MCP / proxy resilience.** The failover secondary keeps being retried while the primary breaker
  is open (instead of the retry cancelling the instant the primary's reset timer fires); a pooled MCP
  upstream reconnects when its URL/IP/auth changes; the session-slot release is exactly-once
  (restoring the `maxSessions` cap); a failed POST keeps its error cause in the JSON logs; malformed
  GraphQL introspection returns a clean error instead of a `TypeError`; a 2xx response whose
  connection resets mid-body is now recorded as a breaker failure rather than a success (so a
  half-broken backend's breaker can still open); and the cross-instance reconcile pass no longer
  throws (aborting the cycle) if a peer deletes a client mid-pass.
- **Admin-UI accessibility.** Focus returns to the trigger when the guard-editor drawer closes
  (WCAG 2.4.3); the copy-to-clipboard buttons announce success through a live region; and the trace
  detail page now renders a proper `<h1>` page title through the shared `PageHeader`.
- **Security:** WebSocket dials — both per-tool `tool_ws` backends and dedicated ws-proxy
  targets — are now actually pinned to the SSRF-validated IP. Each previously re-resolved the
  backend hostname at dial time (the per-tool path via a bare `new WebSocket(url)`; ws-proxy via a
  Node `dns.lookup` override that **Bun's bundled `ws` silently ignores**), reopening the
  DNS-rebinding TOCTOU that the config-time IP validation exists to close. A new `pinnedWsDial()`
  rewrites the connect host to the validated IP literal while preserving the original hostname for
  the Host header / TLS SNI (the WebSocket analogue of the REST path's `makePinnedFetch`).
- Robustness & a11y hardening: guarded two fire-and-forget promises that could surface as
  process-level unhandled rejections (the MCP progress-notification send after a mid-call client
  disconnect; the ws-proxy DNS-revalidation loop); routed `GET /register/schema`'s 503 through the
  shared `sendError()` so it carries `request_id` like every other admin-API error; gave three
  placeholder-only / hidden admin-UI inputs real accessible names; and enabled a type-checked
  ESLint layer on the admin-UI TypeScript modules (which caught three floating Vue Router
  navigations).
- Admin-UI accessibility & reuse: `TogglePill` now owns its `aria-pressed` (removing the duplicated
  binding from all nine call sites); per-field validation errors on the four create forms
  (New Alert / Composite / Consumer / Schedule) now go through `FieldError`, adding the missing
  `role="alert"` so they're announced to screen readers; the three "Connect client" comboboxes get
  accessible names; and `TraceDetailPage` / `ServerDetailLb` reuse `EmptyState` / `HoverPreview`
  instead of re-declaring them.
- `scripts/bump-version.ts` now also updates `docker-compose.yml`'s default image tag
  (`${MCPBRIDGE_VERSION:-<tag>}`) — previously the lone release-artifact reference it didn't bump, so
  after a release a fresh `docker compose up` kept pulling the old version unless the operator set
  `MCPBRIDGE_VERSION`. (The Helm chart already tracked `.Chart.AppVersion`, which the script bumps.)
- `STRICT_CONFIG` (the production "abort boot on any invalid env var" switch) was read at startup
  but not declared in the env schema or documented in `.env.example`, contradicting the schema
  module's own "source of truth" docstring and letting a typo like `STRICT_CONFIGG` slip by
  unflagged. Now declared in `EnvSchema` and documented as a commented example.
- The Servers table's enable/disable toggle labels were hardcoded English (`"Enabled"`/`"Disabled"`)
  — the only user-facing strings in the admin UI that bypassed i18n — so they stayed English under a
  Spanish locale. Now routed through `t('common.enabled')` / `t('common.disabled')`, matching the
  other eight toggle call sites.
- `scripts/extract-routes.ts` was silently generating an **incomplete** route manifest — it captured
  only top-level `app.<method>` routes and dropped all 40 admin sub-router routes
  (`src/routes/admin/*.ts`), and had drifted four routes stale — which left admin-ui's demo-contract
  test blind to them. It now extracts both registration conventions and ships a `--check` mode the
  new parity test uses to gate manifest freshness.
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
