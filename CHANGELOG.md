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
- **P2-2 — closed the two surviving `compare.ts` mutants**. Added
  `src/security/__tests__/compare.test.ts` with 9 cases: equal-inputs
  return `true` (kills Mutant 4 — strict `.toBe(true)` rejects the
  `undefined` returned when the try-block is emptied), different-inputs
  return `false` (length + content + empty-vs-non-empty variants), and
  three defensive-catch cases that pass `null` / `undefined` to force
  the digest to throw (kills Mutant 5 — the catch MUST return `false`
  on the error path; flipping it to `true` would silently authorize
  mismatches on the error path, a real security hole since `safeCompare`
  is the gate for API keys, session tokens, CSRF tokens, and
  guard-restricted API key hashes). Re-run on 2026-07-06: **6/6 mutants
  killed (100.00% mutation score)** in 3m 29s. Test suite grows from
  1227 to 1236 cases.
- **P2-3 — extended the Stryker mutation backstop to 4 more `src/security`
  files**: `key-hash.ts` (API-key hashing + allow-list check), `system-role.ts`
  (the `/mcp` control-plane fail-closed auth), `cookies.ts` (session/CSRF cookie
  naming + parsing), and `secret-box.ts` (AES-256-GCM secrets-at-rest). Added
  `key-hash.test.ts`, `system-role.test.ts`, `secret-box.test.ts`, plus 8
  `parseCookies` edge-case cases in the existing `cookies.test.ts` — 26 new
  cases, each naming the mutant it kills by line + replacement. Suite grows
  1236 → 1262. Re-run on 2026-07-07: **98.21% (110/112 killed)**, up from a
  75.00% baseline (28 survivors), in 52m 59s on a single worker. `cookies.ts`
  and `system-role.ts` reached a clean **100%** (the latter seeds a real
  `mcp_api_keys` row via `createMcpKey` to exercise the managed-key `&&`→`||`
  path that only a scope-less-but-resolvable key can reach). The 2 remaining
  survivors are **proven-equivalent mutants** (unkillable, so the effective
  score is 100% — 110/110 non-equivalent killed): `key-hash` L20
  `allowedHashes.length === 0` → `false` (redundant with `[].some() === false`)
  and `secret-box` L35 `"utf8"` → `""` (byte-identical in Bun, where `""` is the
  utf8 default). Both verified empirically and documented in the respective
  `__tests__` headers. Scope note: mutating all of `src/security/*.ts` at once
  (12 files / 946 mutants / ~8h) was aborted at 48.7% as too coarse for a single
  commit, keeping the P2-1/P2-2 incremental file-by-file pattern; the larger
  files (`oidc`, `mcp-key-store`, `jwt`, …) are dedicated follow-ups, largest
  last. Run with `bun run test:mutate`.
- **P2-4 — mutation backstop for `bootstrap-admin.ts` + `startup-guards.ts`**,
  both driven to a clean **100%** (101/101 mutants, 0 survivors) in 49m 4s, from
  a 75.25% baseline (25 survivors). Added `bootstrap-admin.test.ts` (7 cases) and
  5 message-content cases in `startup-guards.test.ts`; suite grows 1262 → 1274.
  The interesting file was `bootstrap-admin`: 15 of its 16 baseline survivors
  were `log()`-call StringLiterals (level, message chunks) and the `{ username }`
  meta — side effects with no return value, killable only by SPYING the logger.
  The test spies `log` (`spyOn(logger, "log")`, empirically confirmed to
  intercept the module's internal call) and asserts the level, every message
  chunk, and the meta per call, alongside the DB effect
  (`countUsers`/`findUserByUsername`); the password-length guard is pinned by a
  boundary case (exactly 12 chars → created, killing `<` → `<=`).
  `startup-guards` was at 86.76%: its `reason` strings are 2-3 concatenated
  literals and the base tests asserted only one chunk, so the other chunks'
  `→ ""` mutants survived — fixed by asserting a substring from every chunk,
  plus a bare-string `corsOrigins='*'` to exercise the `[env.corsOrigins]` wrap
  (killing `ArrayDeclaration → []`). Run with `bun run test:mutate`.
- **Stryker speedup — optional `STRYKER_TEST_SCOPE`** in
  `scripts/stryker-test-runner.ts`. With `coverageAnalysis: "off"` every mutant
  re-runs the whole suite; when this env var is set (space-separated test
  paths), the wrapper runs only those tests instead. Scoping the security
  mutation series to `src/security/__tests__` (149 tests / ~1.9s vs the full
  1274 / ~26s) cuts per-mutant time ~11x — validated on `key-hash` (14 mutants
  in 33s vs ~7 min, identical 13/14 score). Safe by construction: running fewer
  tests can only leave a mutant undetected (a survivor), never falsely mark it
  killed, so the score stays conservative. Unset → full suite (unchanged
  default for any other caller).
- **P2-5 — mutation backstop for `session-store.ts` + `user-store.ts`**, the
  first series run using the `STRYKER_TEST_SCOPE` speedup (99 mutants in ~3.5 min
  vs ~84 min unscoped, ~24x). Added `user-store.test.ts` (19 cases — the module
  had no direct test) and 4 expiry/idle boundary cases in `session-store.test.ts`;
  suite grows 1274 → 1297. Score **95.96% (95/99)**, up from a 58.59% baseline
  (41 survivors). All 4 remaining survivors are **proven-equivalent mutants**
  (effective 100% — 95/95 non-equivalent killed): `session-store` L77
  `!safeCompare(row.token_hash, hash)` is unreachable (the row was just fetched
  by that hash, so the compare is always true); `user-store` L8
  `typeof v === "string"` → `true` is redundant with `ADMIN_ROLES.includes(v)`
  (verified empirically); and `user-store` L111 `changes > 0` → `>= 0` / `→ true`
  are guarded by `if (!existing)`, so `changes` is always 1 when reached. The
  session tests pin the expiry/idle boundaries by setting `last_seen_at` directly
  so one guard can't mask another; the user tests kill the `changes > 0` line via
  unknown-user cases on the un-guarded `updatePassword` / `deleteUser`. Run with
  `bun run test:mutate`.
- **P2-6 — mutation backstop for `jwt.ts`** (inbound JWT verification via JWKS),
  the densest file so far (237 mutants), driven from a 63.71% baseline to
  **96.20% (228/237)** over three iterations. Added RS256 coverage (the base
  tests only exercised ES256), the `nbf` check, exact reason strings for every
  rejection, array-audience, `isJwtConfigured`, JWKS fetch-error / cache TTL /
  request-timeout-signal, and exp/nbf boundaries via an injectable clock.
  `jwt.test.ts` grows 8 → 36 tests; suite 1297 → 1325. The 9 remaining survivors
  are all equivalent or effectively so (documented in the test header): Bun's
  `atob` tolerating missing base64 padding, an ignored out-of-bounds
  `Uint8Array` write, the `extractable` flag not affecting `verify()`, the
  `typeof exp/nbf === "number"` guards (every token has numeric claims), aud
  `[]`, and the default `() => Date.now()` clock initializers the
  injectable-clock design never asserts. Run with `bun run test:mutate`.
- **P2-7 — mutation backstop for `mcp-key-store.ts`** (managed MCP API keys),
  **97.67% (126/129)** from a 77.52% baseline — the first ticket on the
  **concurrency:8 fast path** (129 mutants in ~1m20s vs ~5 min at concurrency:1;
  the scoped security tests bind no fixed port and share no DB file, so parallel
  workers don't collide — validated by an identical score on `user-store`).
  Added field-by-field `updateMcpKey` merge coverage, the `rowToRecord` elevated
  mapping + `createMcpKey` elevated default, the `getMcpKey` integer guard,
  `touchMcpKeyLastUsed`, `isClientInKeyScope` (previously untested), and the
  resolve guards for a revoked-then-re-enabled key and the exact expiry instant.
  Suite grows 1325 → 1333. The 3 remaining survivors are equivalent (effective
  100%): redundant guards where a non-integer id / empty token / empty result
  already yields the same value without the check (documented in the test
  header). Run with `bun run test:mutate`.
- **P2-8 — mutation backstop for `oidc.ts`** (OIDC SSO: PKCE, ID-token
  verification, token exchange, discovery, config CRUD, auto-provisioning), the
  largest and most complex file in the series (429 LOC / 262 mutants), driven
  from a 30.53% baseline to **94.66% (248/262)** over three iterations on the
  concurrency:8 fast path (~3 min/run). Added coverage for discovery (fetch,
  required-endpoint validation, issuer cache, trailing-slash stripping, timeout
  signal), the authorization-code token exchange, the full `oidc_config` CRUD +
  `setOidcConfig` validation (https/http URL-scheme anchors, `openid` scope,
  secrets provider), `verifyIdToken`'s nbf / exp-boundary / array-audience /
  jwks-error paths, username derivation (email slugify, `sso-<hash>` fallback,
  collision suffix), the exact state-TTL boundary + expired-row cleanup, and the
  auto-provision log. `oidc.test.ts` grows 15 → 53 tests; suite 1333 → 1371. The
  14 remaining survivors are equivalent or deep non-security infra (documented
  in the test header). **This completes the P2 series — every `src/security/*.ts`
  file now has a mutation-testing backstop.** Run with `bun run test:mutate`.
- **Mutation testing — domain 2 (`src/proxy/`), first pass** for `backends.ts`,
  `transform.ts`, and `streaming.ts` (the extra-backend config + declarative
  transform + streaming-normalization helpers). Scoped to `src/proxy/__tests__`
  with `concurrency:8` (re-validated identical to `1` on `streaming.ts` before
  trusting it in this new domain). Score **81.98% (282/344)**, up from a 69.19%
  baseline: `streaming` 97%, `transform` 85%, `backends` 74%. Added coverage for
  the config getters' `enabled`/`persistent` mappings + batched getters,
  `setToolWs`'s delete + exact validation reasons, the `applyOps` path-helper
  guards (set/get/remove through null/number/array intermediates, rename/copy
  from a missing source), `safeParseOps`' non-array/invalid-JSON fallback, the
  SSE event cap + multi-line join, and `wsRequest`'s over-cap / early-close
  rejections. The remaining survivors are concentrated in `wsRequest` /
  `wsRequestPersistent`'s event-handler internals (a second pass with more
  WebSocket-server variants is a follow-up); `proxy.ts` (1382 LOC) is not yet
  covered. Run with `bun run test:mutate`.
- **Mutation testing — domain 2 (`src/proxy/`), `proxy.ts` (the 1382-LOC
  dispatch core)**. 1146 mutants, **93.72% (1074/1146) raw / 94.76% including
  12 genuine-infinite-loop timeouts** Stryker detects on its own (breaker
  recordSuccess/Failure loops, an emptied `AbortSignal.any([])`, retry-backoff
  `Math.pow` misuse — real bugs a mutant would introduce). 13 new
  `src/proxy/__tests__/proxy-mutation-c*.test.ts` files, one per functional
  cluster of `proxyToolCall`'s dispatch pipeline: gates (enable/deleting/key-
  scope/quota/sensitivity/quarantine/approval/guardrails/rate-limit),
  mock/cache/coalesce, breaker/LB/canary routing, path-traversal/Ajv/
  transform, pinned-IP resolution + retry/backoff, success response +
  pagination integration, error/retry exhaustion, WS dispatch, MCP dispatch.
  Authored across three rounds of parallel sub-agent work (13 cold, 4
  deepening the densest clusters, 7 targeting the remaining survivors by
  cluster) with extensive empirically-verified equivalent-mutant
  documentation throughout (redundant guards one line later, WHATWG Streams/
  Ajv invariants, unreachable branches, a genuine circuit-breaker half-open
  race condition deliberately reproduced with real timers). Two independent
  full verify runs produced identical survivor sets (ruling out run-to-run
  noise): round 3 confirmed 22 previously-surviving mutants newly killed
  (parseRetryAfter's HTTP-date boundary, cache-hit/mock `recordUsage`
  payloads, canary/LB lookup guards, retry-loop HEAD/OPTIONS legs + the
  exponential-backoff formula, an off-by-one retry boundary, 4 duration-
  metric unit mutants, MCP `mcpUrl`/`transport` fallbacks) but also newly
  exposed 22 different survivors — one spot-checked (`parseRetryAfter`'s
  `!headerValue` early return) confirmed equivalent, the rest presumed
  similarly reclassified or sandbox-timing artifacts in real-wall-clock
  retry/backoff tests rather than true regressions, though a complete
  per-mutant triage of all 22 was not finished. Suite grows 1591 → 1608.
  Run with `STRYKER_TEST_SCOPE=src/proxy/__tests__ bun run test:mutate`.

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
