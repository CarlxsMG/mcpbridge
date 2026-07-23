# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`SUPPORT.md`** — routes each kind of question to the right place (docs, Discussions, bug vs
  feature templates, private security advisories) and spells out what makes a gateway bug report
  actionable: the endpoint the call took, the backend kind, and a redacted request/response trace.
  GitHub surfaces it automatically from the issue composer. A commented-out `.github/FUNDING.yml`
  ships alongside it, ready to enable once GitHub Sponsors is set up on the account.
- The Helm chart now declares an `icon`, the last thing `helm lint` was flagging.
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
- **admin-UI coverage gate** — `@vitest/coverage-v8` with a ratchet-floor threshold (lines 65 /
  statements 62 / functions 58 / branches 48), wired into CI and `bun run check`. The SPA previously
  ran `vitest` with no threshold at all, so its coverage could silently decay; the backend already
  gates at 90/85.
- **CLI — top-level `--help`/`-h` and `version`/`--version`/`-v`.** `gateway --help` (or a bare
  invocation) now prints usage to stdout and exits 0 instead of falling through to the
  unknown-command path and exiting 1; `version` prints the package version, read via the same
  static `package.json` import the MCP server uses so it resolves under both `bun run cli` and a
  compiled standalone binary. The usage string gains a Flags section and lists the shipped
  `connect` and `version` commands.
- `examples/` — a copy-and-run directory of sample configs: `gateway.yaml` (annotated
  config-as-code matching the exact `ConfigExport` shape `gateway pull` emits), one
  `register/*.json` body per registration mode (openapi, curl, postman, manual, graphql,
  mcp-upstream — `openapi.json` targets the real Swagger Petstore and works unedited), and
  paste-ready `mcp-clients/{claude-desktop,cursor}.json` client configs matching `gateway connect`
  output.
- CI now **boots the built artifact and polls `/livez`** before the Trivy scan, for both
  `docker-publish.yml`'s container image and `release-binaries.yml`'s standalone `bun`-compiled
  binaries (the `bun-linux-x64` leg, the one this runner can natively execute) — previously both
  pipelines built, scanned, and published purely on the strength of the build succeeding, so a
  broken `CMD`/`ENTRYPOINT`, `COPY` path, or env-wiring mistake would pass every gate undetected.
  The Helm lint job also renders a second `values` file exercising `existingSecret`,
  `persistence`, and an external `ServiceAccount`, which the default-only render left untouched.
- **Admin UI — a super-admin can now grant or edit a managed key's system role** directly (a
  "System role" select on the New API Key form, plus an inline edit control on the Keys table),
  instead of needing a raw `curl` call to `PATCH /admin-api/mcp-keys/:id` to mint a key with
  `/mcp` control-plane access. Both controls are gated to super-admin callers, mirroring the
  backend's `isSuperAdminCaller` check, so a team-scoped admin never sees a control it would
  just get a 403 from; `GET /admin-api/auth/me` now reports the session's `team_id` (`null` =
  super-admin) so the UI can decide when to show it.
- **MCP tool annotations (2025-06-18) on `tools/list`, plus faithful upstream passthrough.** Every
  bridged tool now advertises the standard governance/presentation hints —
  `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` and a display `title` — derived
  from its HTTP method and its sensitivity/approval gating, and an MCP upstream's own declared
  `title`/`annotations` are folded through verbatim. The hints are advisory: they COMPLEMENT
  `proxyToolCall`'s call-time enforcement, never replace it.
- **Request-log correlation and a build-info metric.** Every structured log line emitted while
  handling a request is stamped with a `request_id` (taken from an inbound `X-Request-Id` header
  or a fresh UUID, and echoed on the `X-Request-ID` response header), so a single request can be
  grepped end to end; and a constant `mcp_build_info` gauge carries the running `version`/`bun`
  runtime as labels for a dashboard to pin the live build and spot replica skew.
- A structural tenancy-route matrix test asserting every admin-API route carries its expected
  role/team gate, so a newly added route can't silently ship without tenancy scoping.

### Changed

- Design-system consistency: the always-dark layout chrome (sidebar, mobile topbar, demo ribbon,
  command palette) and the overlay/radius values now render from design tokens instead of hardcoded
  colors, and dropdown/listbox overlays get a dedicated `--z-popover` z-index.
- i18n tooling: the source→bundle key check is folded into `admin-ui/scripts/check-i18n.mjs` (the
  standalone Python i18n-audit workflow and its scripts are retired), run by `bun run check` and CI.
- Developer workflow: the pre-push git hook now typechecks, the local `bun run check` enforces the
  backend coverage floor (matching CI), and Dependabot commits are conventional-commit-compliant,
  grouped, and skip the load-bearing version pins (`ajv`, `zod`, `@scalar/openapi-parser`).
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
- Docs: the README quickstart now notes that the Bun dev path serves the backend on `:8790` (its
  `curl`/client/CLI examples use the Docker port `:3000`), so an Option-B copy-paste no longer
  connection-refuses; the `bun run check` step list in CONTRIBUTING gained the missing
  `typecheck (tools)` step; and `.env.example` documents the `AUTH_DISABLED` /
  `ALLOW_UNSAFE_AUTH_DISABLED` escape hatch it already referenced.
- Documentation: corrected several more stale/inaccurate claims (EN+ES where a Spanish
  counterpart exists) — CLAUDE.md and `threat-model.md` said the pinned backend IP is "never
  re-resolved" (it's actually re-validated on a 5-minute TTL, `IP_PIN_TTL_MS`/
  `refreshPinIfStale`); CLAUDE.md attributed root `/mcp` to `mcpAuth` instead of `rootMcpAuth`
  (and still listed the removed `/sse`/`/messages` routes under it); `scaling.md`/`deployment.md`/
  `observability.md` told operators to point a general throughput-scaling load balancer at
  `/readyz`, which is 200 only on the current leader — reworded to recommend `/health`/`/livez`
  for routing and reserve `/readyz` for a deliberate active/passive failover topology; the CLI
  guide's `gateway.yaml` Petstore example doubled a path prefix OpenAPI discovery already folds
  in; the Dockerfile header overstated what a `BUN_VERSION` bump without a matching digest bump
  does (it goes silently stale, it doesn't fail the pull); `monitoring/README.md`'s example
  Prometheus scrape target didn't match `docker-compose.yml`'s real service name; and the OpenAPI
  spec documented the canary `weight` field as a 0-1 fraction instead of the actual 1-100 integer
  percentage `setCanary()` requires.
- Internal: deduped `errorMessage()` usage across `registration.ts`/`leader-loop.ts`/
  `mcp-upstream.ts`, dropped an unused `RegistrationPayload` interface and an always-0
  `inflightRequests` shutdown-log field, corrected stale doc comments, and reconciled
  `config-schema.ts`'s parsed defaults for `SESSION_COOKIE_SECURE`/`ENABLE_SEARCH_TOOL`/
  `METRICS_ENABLED` with `config.ts`'s actual `!== "false"` runtime default (both previously
  defaulted to `false` when unset).
- Internal: `response-cache.ts` replaced six literal embedded NUL-byte cache-key separators
  (which made git treat the whole file as binary — `git diff`/`git blame` silently skipped it)
  with a named constant, and dropped a private `stableStringify` that duplicated the one already
  exported from `lib/stable-json.ts`; cache keys are byte-identical, behavior unchanged.
- Internal: deduped a byte-identical `validateExpiresAt` from `bundles.ts`/`mcp-keys.ts` into
  the shared `admin-validators.ts`, fixed a stale `eslint.config.js` comment referencing the old
  `src/transports.ts` path, documented `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`/
  `ALLOW_PRIVATE_IPS` in `CONTRIBUTING.md` (previously only in CLAUDE.md), and removed three
  one-shot i18n Python scripts confirmed to have zero remaining references.
- Internal: `checkSensitiveToolGate` (the REST/MCP-upstream dispatch path in `proxy.ts`) and
  `runSystemTool`'s `/mcp` system-tool catalog each hand-rolled an identical `__confirm`/elevated
  step-up check. Extracted into a shared `checkConfirmGate()` in `src/proxy/gates.ts` so the
  step-up semantics and rejection message can only be defined once.
- Docs: `gateway connect --scope system` (CLI and the admin UI's "Connect client" dialog) now
  gives scope-aware key guidance — a system-scope connection needs a key with an `adminRole` set
  (or the env admin Bearer), not just any enabled MCP API key, which the previous one-size-fits-all
  hint didn't make clear. The admin-UI key-count hint/warning is filtered the same way.
- Docs: CLAUDE.md's Resilience section overstated that POST/PUT/PATCH are never retried on
  failure — PUT/DELETE are retried when a client opts into the per-client
  `retry_non_safe_methods` flag, matching `src/proxy/dispatch-rest.ts` and
  `docs/guide/registering-backends.md`, which already documented the flag. CLAUDE.md's Commands
  section also gained the previously-undocumented `bun run test:mutate` (Stryker) command, and
  its CI summary now covers the required `e2e` job plus `codeql.yml` and `security.yml`.

### Removed

- `@scalar/types` — an unused direct dependency (never imported in `src/`, not a peer requirement of
  `@scalar/openapi-parser`).

### Fixed

- **A high-severity advisory in a transitive dependency would have failed CI on the first push
  (P1).** GHSA-v2hh-gcrm-f6hx (host confusion via a literal backslash authority delimiter) affects
  `fast-uri` `>=3.0.0 <=3.1.3`; the lockfile pinned `3.1.3` under `ajv`, so
  `bun audit --audit-level=high` — the gate `security.yml` runs on every push and PR — exited 1.
  Moved only the lockfile's `fast-uri` entry to `3.1.4`, which satisfies `ajv`'s declared
  `^3.0.1` in place: no direct dependency added, the load-bearing exact `ajv@8.18.0` pin
  untouched, and no second physical copy of `fast-uri` in the tree. The two remaining moderate
  advisories (`qs` under Stryker, `@hono/node-server` under the MCP SDK) are now both documented
  as accepted in `security.yml`, with the reasoning for why neither is reachable in production.
- **Security — MCP `resources`/`prompts` reads bypassed a managed key's client scope (P0).**
  `mcpParamsForScope()` already restricted tool calls to a key's allowed client
  (`isToolInKeyScope`), but ignored that same scope for `resources/read` and `prompts/get` on the
  shared `/mcp/:clientName` route, so a key restricted to one client could still read another
  client's resources and prompts. That content also skipped the guardrail scan and credential-strip
  the tool-call path already applies — letting an untrusted MCP upstream smuggle a
  prompt-injection payload through resource/prompt content as easily as through a tool result.
  Both gaps are now closed: resources/prompts are scope-checked and sanitized identically to tool
  calls.
- **Security — the IPv4 SSRF blocklist was missing ranges the IPv6 path already covered (P1).**
  `BLOCKED_IPV4_CIDRS` omitted TEST-NET-2/3, RFC-2544 benchmarking, RFC-1112 multicast, reserved,
  and limited-broadcast ranges, so a backend registered against an address in one of them passed
  SSRF validation. Now matches the IPv6 blocklist's coverage.
- **Ops — health probes pointed at the wrong endpoint.** The Helm chart's startup/liveness/readiness
  probes and the Dockerfile `HEALTHCHECK` all targeted the legacy always-200 `/health`, even though
  the gateway ships a purpose-built probe trio — `/livez` (always-200 liveness) and `/readyz` (200
  only when SQLite answers and the leader lease is held) — so neither Kubernetes readiness nor the
  container healthcheck could detect a wedged/locked SQLite handle. Liveness and startup now probe
  `/livez`, readiness probes `/readyz` (documented in `values.yaml` as leader-gated — switch back to
  `/livez` if scaling past one replica).
- **Docker image build was broken (P0).** The deps-stage `bun install --production` ran the root
  `prepare` hook (`lefthook install`), but `lefthook` is a devDependency `--production` omits (and
  the stage has no `.git`), so the script exited 1 and `docker build` failed outright — breaking
  compose `build:`, the Helm image, `docker-publish.yml`, and the CI docker job. Added
  `--ignore-scripts` to that install. The image is now also secure-by-default (`ENV
NODE_ENV=production`, and the prod compose pins it so a copied dev `.env` can't disable the
  startup guards).
- **Security — team-scoped admins could escape their tenant.** The team multi-tenancy boundary was
  enforced on the per-client routes but not the global ones: user CRUD, DB backup, and config
  export/import ran behind `requireAdminRole` (which a team-scoped admin passes) instead of
  `requireSuperAdmin` — so a team admin could create a teamless (super-admin) user, download the
  whole multi-tenant DB, or read/rewrite another tenant's config. Additionally, `upstream-auth` and
  `GET /traffic/:id` skipped the `ensureClientAccess` check their siblings enforce (the traffic list
  wasn't team-scoped either), and `mcp-keys` gated `adminRole`/`elevated` on super-admin but not
  `scopes` — letting a team admin mint an unrestricted data-plane key. All now confined to the
  caller's tenant; bearer/CI and the teamless bootstrap admin are unaffected.
- **Security — JWT & SSO auth survived an IdP key rotation.** Both JWT verifiers rejected a token
  whose `kid` wasn't in the cached JWKS without refetching, so a routine signing-key rotation locked
  out all JWT data-plane auth and SSO admin login until the cache TTL (10 min) lapsed. On a `kid`
  miss they now force one (rate-limited) JWKS refetch before rejecting.
- **REST auto-discovery dropped an absolute OpenAPI server URL's path prefix.** A spec whose
  `servers[0].url` is absolute with a path (`https://host/api/v3` — Petstore/Stripe/GitHub) yielded
  an empty base path, so every discovered operation lost its `/api/v3` prefix and 404'd once proxied.
  The pathname is now kept (the origin still comes from the client's `base_url`).
- **WebSocket tool dispatch now validates arguments like the REST/MCP paths.** The WS path only
  hand-deleted two fields and never ran the tool's Ajv schema, so the internal `__end_user` field and
  any unknown caller keys leaked to the backend and malformed args were forwarded rather than
  rejected. It now runs the same `removeAdditional:"all"` validation.
- **Approvals — a reject could 500 without recording who rejected.** The reject branch flipped the
  ticket to `rejected` and only then inserted the decision row, so a same-actor approve-then-reject
  hit `UNIQUE(approval_id, decided_by)` uncaught after the status had committed. The decision is now
  inserted first (catching the duplicate like the approve branch), then the status flips.
- **Security — the MCP rate limit couldn't be escaped by rotating the session id.** `rateLimitMcp`
  keyed only on the client-controlled `mcp-session-id`, so a fresh id per request got a new bucket
  every time. A per-IP ceiling is now checked first, with the session id only subdividing beneath it.
- **Security — the audit hash-chain can't fork under HA.** `recordAudit` read the chain tip and
  inserted in a _deferred_ transaction, so two instances could read the same tip and fork the chain
  (later flagged as tampering). It now uses `BEGIN IMMEDIATE`.
- **Security — the CSV audit export is hardened against spreadsheet formula injection.** A field
  starting with `= + - @` (user-controlled `actor`/`target`) is now prefixed with a single quote so
  Excel/Sheets treats it as text.
- **The Overview dashboard surfaces data-source failures instead of silent zeros.** A dead backend
  rendered empty/zero widgets while the refresh spinner stopped as if it had succeeded; the recorded
  per-source errors are now shown in a banner.
- **Resource hygiene:** load-balancer runtime state (round-robin cursor, per-target cooldown/inflight)
  is now dropped on client/target teardown instead of leaking across churn; expired and revoked
  `admin_sessions` rows are pruned opportunistically instead of accumulating forever; upstream MCP
  `tools/list` pagination is bounded so a malicious upstream can't OOM/hang discovery.
- **cURL import handles combined boolean-flag clusters.** `curl -fsSL <url>` (and `-sSf -X POST`)
  previously mis-parsed — the cluster was treated as value-taking and swallowed the URL or the `-X`.
  Any single-dash cluster of only known boolean short flags is now decomposed.
- **Alert webhook URLs are SSRF-validated at store time** (defense in depth; they were already
  validated at fire time), giving the admin immediate feedback on a bad URL.
- **Admin UI — accessibility & UX.** `TabStrip` now implements the real WAI-ARIA tabs keyboard model
  (roving tabindex, arrow/Home/End, `tabpanel` wiring) instead of exposing `role="tab"` with no
  keyboard support; client-side navigations move focus to the main region and announce the localized
  page title in a polite live region (WCAG 2.4.3); `ListLayout` no longer stacks a load error on top
  of the empty state; the tool enable/sensitive toggles use the shared optimistic-toggle composable
  (double-click race); and two pages dropped duplicate local `tk()` re-implementations.
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
- Graceful shutdown is now re-entrant-safe (a second `SIGTERM` during shutdown is ignored) and every
  housekeeping timer — the health/alert/schedule loops, the circuit-breaker and rate-limiter sweeps,
  the registry-reconcile loop, and the leader-election loop — is `unref`'d, so background work never
  keeps the process alive on its own.
- The OpenAI context-budget summarizer sends `max_tokens`, bounding the summary response size.
- Accessibility: inline save errors and success confirmations are announced to assistive tech
  (`role="alert"` / `role="status"`); the command palette exposes correct combobox/listbox semantics;
  form controls are properly labelled; and required schema-form fields are marked programmatically.
- Localization: eight previously-English error messages and the command palette's leaked UI strings
  are translated, and the Spanish README's "read more" links now point at the Spanish (`/es/`) docs.
- **The compiled Ajv schema-validator cache wasn't invalidated on tool re-registration or
  teardown.** Unlike every other piece of per-client runtime state (pinned IP, circuit breaker, LB
  state, response cache) that `registry.ts` already cleans up on `register()`/`registerMcp()`'s
  re-registration branch and `teardownLiveClient()`, `getOrCompile()`'s validator cache was keyed
  only by `clientName::toolName` and never busted — so tightening a tool's `inputSchema` (e.g.
  adding an enum allowlist) on re-registration silently kept enforcing the old, looser schema until
  process restart. Added `invalidateCompiledSchemasForClient()`, wired into the same three call
  sites the sibling invalidations use.
- **Admin UI — pagination `Prev` could get stuck before page one.** `useCursorPagination`'s
  `load()` applied its `cursor = currentCursor.value` default parameter whenever the argument was
  `undefined` — including when `prev()` explicitly passed the popped `undefined` sentinel meaning
  "go back to the cursor-less first page" — silently replacing it with the stale current cursor, so
  clicking Prev enough times never actually returned to page 1. Affected every page using the
  composable (Servers/Traces/Traffic/AuditLog); split into a default-applying wrapper plus a
  `fetchAndApply(cursor)` that `next()`/`prev()` call directly with the exact cursor.
- **Admin UI — a mislabeled column, a stale-filter URL-sync bug, and a couple of i18n gaps.**
  `AlertsPage`'s "Threshold" column actually rendered `lastFiredAt` (now a real threshold
  formatter, correctly labeled "Last fired"); `ServersPage`/`TrafficPage` wrote the live
  (unsubmitted) filter value into the URL when paginating right after typing but before submitting
  a filter change, instead of the applied-filter snapshot; `ApprovalsPage`'s empty state
  interpolated a raw tab key instead of its translated label; and `SsoSettingsPage` had a literal
  `{issuer}` placeholder (needed `{{ issuer }}`) that never interpolated the admin's typed value.
- **Admin UI — an unsaved-changes guard gap, misrouted delete errors, and a locale-dependent
  status badge.** `NewTeamPage` was the only one of 11 `New*Page` create forms missing the
  `useUnsavedChangesGuard` + `ConfirmDialog` wiring every sibling page has; `SchedulesPage` routed
  delete failures into the row-level toggle error slot instead of the page-level error banner every
  other list page uses; and `ShareInstallLinkDialog` derived its status badge's CSS class from the
  already-translated label text, which only matched by coincidence in English and silently dropped
  color-coding under a Spanish locale — switched to the shared `StatusBadge`, keyed off the raw
  status enum.
- **CLI — a non-JSON admin-API response now raises a `CliApiError` instead of a bare
  `JSON.parse` error.** `makeClient()`'s `doFetch` always ran `JSON.parse` on the response body
  before checking `res.ok`; every admin-API route returns JSON, but the CLI talks to an
  operator-supplied `--url` over the network, so a wrong port, reverse proxy, or load-balancer
  error page produced a cryptic `SyntaxError` instead of the HTTP-status-aware `CliApiError` every
  other CLI failure path relies on.
- **Security — team-scoped admins could overwrite another tenant's guard policy (P0).**
  `POST /admin-api/policies/:id/apply` accepted a caller-supplied `{client, tool}` list (or a
  bundle's resolved tool list) and applied it straight to `registry.applyGuardPolicy()` with no
  ownership check, even though the route is gated only by `requireAdminRole` (a role check, not
  tenancy). A team-scoped admin could silently overwrite or null out another tenant's
  rate-limit/timeout guard on a client they don't own and can't see in their own dashboard.
  `applyPolicyToTools`/`applyPolicyToBundle` now take an optional per-caller team confinement.
- **Security — schedule CRUD had no tenancy check (P1).** The `POST`/`PATCH`/`DELETE` schedule
  routes were gated only by `requireOperator` (role, not team) and never verified the target
  client's ownership, so a team-scoped operator could create a schedule against another tenant's
  client, or enable/disable/delete any schedule by id regardless of which team's client it
  targets; `GET /admin-api/schedules` also returned every tenant's schedules unfiltered. Added
  `getSchedule()` and a `teamId` filter to `listSchedules()`.
- **Security — `GET /admin-api/approvals` leaked every tenant's approval tickets (P1),**
  including `argsJson` — the raw, unredacted arguments of the tool call that triggered the
  approval requirement — despite having no role gate or team filter at all, unlike the two
  mutation routes in the same file that already call `ensureClientAccess`. `listApprovals()` now
  takes an optional `teamId`, mirroring `listTraffic`'s existing pattern.
- **Security — the two `GET /admin-api/mcp-keys` routes returned every managed key unfiltered
  (P2),** regardless of the caller's role or team, unlike every mutation in the same file. A
  team-scoped session of any role could enumerate every key in the system, including other
  tenants' `scopes.clients` (which `ensureClientAccess` elsewhere deliberately hides behind a
  uniform 404) and which keys carry `adminRole`/`elevated` (control-plane privilege). Both routes
  are now team-scoped.
- **Admin UI — accessibility.** The server-detail page's team-ownership `SelectMenu` and the
  Policies page's per-row "Apply to bundle" `SelectMenu` both rendered with no accessible name
  (no `id`/`aria-label`/`title`/wrapping `<label>`), unlike their sibling Mode/Strategy selects;
  both now get an `aria-label` matching that established pattern (the Policies one interpolates
  the policy name, since it repeats once per row).
- **Admin UI — i18n missing-key console warnings weren't actually silenced.**
  `silentFallbackWarn`/`silentTranslationWarn` are legacy vue-i18n option names ignored under
  `legacy: false`; the real "Not found key" warning is gated by `fallbackWarn`/`missingWarn`,
  which fired on every route whose name isn't a `nav.*` key despite the code comment claiming it
  was suppressed. Fixed in `admin-ui/src/i18n.ts` and its `test-setup.ts` duplicate.
- **OpenAPI parameter routing honors each parameter's declared `in:` location.** A discovered tool
  now places every argument into the request part its spec declares (`in: query`, `header`, or
  `cookie`) instead of defaulting every non-path param into the query string or POST body; the
  resolved mapping (`paramLocations`) round-trips through the DB (migration 56) and is returned by
  `GET /clients/{name}/tools`. Includes the follow-up fixes to that initial routing change.
- **A GraphQL backend's HTTP-200-with-`errors` response now trips the circuit breaker.** A
  GraphQL-over-HTTP operation that fails answers 200 with a top-level `errors[]` (and null/absent
  `data`); that is now recorded as a breaker/usage failure and surfaced as an error instead of
  counting as a success, so a consistently-failing GraphQL tool can still open its breaker.
  Ordinary JSON that merely carries an `errors` field is unaffected (the check is gated on
  GraphQL-backed tools).
- **Stopped advertising an unusable upstream `outputSchema`.** A bridged MCP-upstream tool no
  longer advertises the upstream's `outputSchema` on `tools/list`: the result path is text-only
  (no `structuredContent` passthrough) and the official MCP SDK client throws `InvalidRequest`
  when a tool advertises an `outputSchema` but the call returns no structured content — which would
  have broken every call to such a tool.

### Security

- Per-tool **transform** ops and response **redaction** paths now refuse the dot-path segments
  `__proto__`, `constructor`, and `prototype` — both at the admin validator boundary (a clear `400`)
  and in the shared traversal helpers themselves — closing an operator/team-scoped prototype-pollution
  vector that could otherwise mutate `Object.prototype` process-wide (a cross-tenant escape).
- The WebSocket proxy caps inbound frame size at the protocol layer on both the tool-backend and
  ws-proxy legs, so an oversized frame can't exhaust memory before the app-level guard runs.
- The pinned resolved-IP cache is invalidated when a client re-registers, so a re-registration to a
  new address can't be dispatched against a stale (DNS-rebinding-relevant) pinned IP.
- OpenAPI/Swagger discovery enforces the 5 MB spec cap **during** the streamed read rather than only
  after buffering, bounding memory on a hostile or oversized spec URL.
- The Helm chart runs under a dedicated `ServiceAccount` with `automountServiceAccountToken: false`,
  so pods no longer get the namespace default service-account token mounted.
- Introspection reads are confined to the caller's tenant, an IPv6 literal is bracketed correctly
  when it is pinned into the outbound connect target / `Host` header (closing an SSRF-pin
  edge the IPv4 path didn't hit), and a WebSocket tool call that consumes the single half-open
  circuit-breaker probe but bails before dispatch now releases it, matching the REST/MCP paths.
- The gateway strips its own injected upstream credential from a reflected response independently
  of the auth scheme (not only `Bearer`), closing a reflection gap for custom-scheme credentials.
- An MCP upstream's faithfully-passed-through `title`/`annotations` are prompt-injection-sanitized
  before entering the registry (the same treatment `description` already gets), and a tool argument
  routed to a `header`/`cookie` location can no longer inject a forbidden header, smuggle CRLF/`;`
  into a cookie, or overwrite a gateway-managed auth header.

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

[Unreleased]: https://github.com/CarlxsMG/mcpbridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CarlxsMG/mcpbridge/releases/tag/v1.0.0
