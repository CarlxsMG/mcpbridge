# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MCP REST Bridge is a **Bun** + TypeScript (strict) server that bridges MCP (Model Context
Protocol) clients to backend REST APIs and other MCP servers. It keeps a dynamic client/tool
registry, advertises a unified tool list, and proxies every call through one uniform guard
pipeline (SSRF check → guardrails → per-tool policy → circuit breaker → dispatch → response
sanitizing → audit). It's bidirectional: REST/OpenAPI → MCP auto-discovery, **and** MCP → MCP
gateway/aggregator.

The repo is two projects in one:

- **Root** — the gateway itself (Express 5 + `@modelcontextprotocol/sdk`, `bun:sqlite`, no ORM).
- **`admin-ui/`** — a fully separate Vue 3 + Vite SPA (own `package.json`/lockfile, zero shared
  deps with the backend), served at `/admin` in production and talking to a JSON admin API at
  `/admin-api/*`.

**Why Bun, specifically (not optional, not swappable for Node):** DNS resolution relies on
`Bun.dns` (structured `{ address }` results, used for the SSRF-safe IP-pinning below); persistence
uses `bun:sqlite` (no `better-sqlite3`); password hashing uses `Bun.password` (argon2id, no
`bcrypt`). Don't introduce Node-only equivalents of these.

**Two exact-pinned deps — don't "helpfully" bump them.** `ajv` is pinned to `8.18.0` (not
`^8`) so the dependency tree dedupes to a single physical copy — a second nested `ajv` under
`ajv-formats` reintroduces a real TypeScript type conflict. `zod` is held at `4.3.6` because
`4.4.x` broke `validateEnv` (the env-schema validation, ~46 test failures). Both pins are
load-bearing; change them only behind a deliberate test pass, never in a routine dependency
sweep. (`bun-types` is exact-pinned too, but self-evidently — it must match
`packageManager`/`.bun-version`.)

**Patching a vulnerable _transitive_ dep: use `overrides`, and scope it to the major.** Neither
`bun update` form works here. Bare `bun update` rewrites every caret range in `package.json`
(an unrelated 18-minor MCP SDK jump inside a security commit); `bun update <name>` on a
transitive is worse — it **adds `<name>` as a new direct dependency** at the latest version
(into `dependencies`, even for a dev-only package) and leaves the vulnerable nested copy in
place. The working tool is an `overrides` entry, keyed **`"pkg@<major>"`, not `"pkg"`**: a bare
key forces _every_ copy in the tree to the new version regardless of what each consumer
declared. That is not hypothetical — `"brace-expansion": "^5.0.8"` dragged the `^2.0.2` copies
under `minimatch@9` up to 5.x, and brace-expansion 5 dropped its default export, so
`minimatch@9` died with `brace_expansion_1.default is not a function`. `"brace-expansion@5"`
moves only the 5.x line and leaves 2.x alone. Two traps when verifying: a stale `node_modules`
keeps serving the old nested copy, so re-resolve with `rm -rf node_modules && bun install`
before believing a result; and the unit suites may never load the broken path (admin-ui's 386
tests passed green with `minimatch@9` fully broken) — exercise the actual require chain.

## Commands

Run from the repo root unless noted. `admin-ui/` is a separate TypeScript project with its own
scripts — most checks must be run in both places.

```bash
bun install                          # root deps
cd admin-ui && bun install           # admin UI deps (separate lockfile)

bun run dev                          # gateway with --watch
cd admin-ui && bun run dev           # admin UI dev server (vite)
bun run dev:all                      # both together (scripts/dev-all.ts)
bun run cli -- <command>             # the bundled config-as-code CLI (src/cli)

bun run check                        # everything CI's `test` job checks, in one shot (scripts/check-all.ts):
                                      # format:check → lint (root) → lint (admin-ui) → i18n parity (admin-ui)
                                      # → typecheck (root) → typecheck:tools (root) → test (root)
                                      # → typecheck (admin-ui) → test:coverage (admin-ui) → build (admin-ui)
bun run check:full                   # the above PLUS the CI jobs outside `test`: version-parity,
                                      # docs build, helm lint/template ×3, promtool rule check.
                                      # helm/docker steps SKIP with a notice when the binary is
                                      # missing — they still gate in CI. Run this before pushing
                                      # anything that touches helm/, monitoring/, docs/ or a
                                      # version-pinned file; plain `check` cannot see those.
                                      # Still not covered by either: e2e (`bun run test:e2e`),
                                      # docker-build, the Windows test leg, and commitlint (the
                                      # lefthook commit-msg hook already runs it per commit).

bun run format:check && bun run lint # prettier --check + eslint, root only
tsc --noEmit                         # backend type-check
bun run test                         # backend tests (NOT bare `bun test` — see gotcha below)
cd admin-ui && bun run lint          # admin UI eslint
cd admin-ui && bun run typecheck     # admin UI type-check (vue-tsc -b --noEmit)
cd admin-ui && bun run test          # admin UI tests (vitest run)
cd admin-ui && bun run build         # admin UI production build (also type-checks)

bun test path/to/one.test.ts         # run a single backend test file directly (fine — scoping only breaks with no args)
bun run test:e2e                     # Playwright e2e (e2e/) — separate from `bun run check`, boots a real browser + backend
bun run test:mutate                  # Stryker mutation testing (stryker.config.mjs) — separate from `bun run check`
```

**Never run bare `bun test` (no args) from the repo root.** Bun's default test discovery
recurses the whole tree and matches both `*.test.ts` and `*.spec.ts`, so it also sweeps up
`admin-ui/src/**/__tests__/*.test.ts` (Vitest specs needing jsdom — fail with "document is not
defined" under bun's runner) and `e2e/*.spec.ts` (Playwright specs — fail with "Playwright Test
did not expect test() to be called here"). A positional filter like `bun test src` does **not**
scope correctly either, since bun matches it as a path substring and `"src"` also matches
`"admin-ui/src/..."`. Always use `bun run test`, which passes
`--path-ignore-patterns={admin-ui,e2e}/**`.

**Never let a test depend on ambient state.** All 372 backend test files run in a **single**
`bun test` process, sharing one `bun:sqlite` connection, one `config` object, and one set of
rate-limiter counters. `bunfig.toml` preloads `src/__tests__/_utils/test-isolation.ts`, which
resets all three before every test — that is a safety net, not a licence: pin what a test needs
(`config.allowPrivateIps = true` for loopback fixtures, and so on) inside its own setup, and
prefer `withConfig()` for scoped overrides. Two consequences worth knowing: a `beforeAll` that
seeds the **database** will not survive (the reset runs before each test — seed from
`beforeEach`), and snapshotting a config value at module-load time is unreliable, since it
captures whatever an earlier file already left behind. Reading a value from a gitignored `.env`
is the other trap: it makes the suite pass locally and fail in CI, which has none.

CI (`.github/workflows/ci.yml`) runs format-check/lint/typecheck/test/build on every push and PR,
plus a required `e2e` job (full Playwright suite, `needs: test`); `codeql.yml` runs GitHub CodeQL
SAST on every push/PR to `main` plus a weekly cron; `security.yml` runs a PR dependency review
plus a `bun audit` (root, admin-ui, docs) on every push/PR and weekly; `docker-publish.yml`
publishes to GHCR on `v*` tags; `release-binaries.yml` builds standalone binaries; `deploy-docs.yml`
publishes the VitePress site in `docs/`.

**Read CI warnings from the annotations API, not `gh run view`.** `gh run view` does not surface
annotations for every workflow, which is how a CodeQL Action deprecation with a hard date sat
unnoticed while three separate passes declared the same migration "complete". The reliable form is
`gh api repos/<owner>/<repo>/check-runs/<job-id>/annotations` over each job of a run. A related
tell: an annotation naming an action WITHOUT a SHA when every pin in these files carries one means
the warning is transitive — it comes from inside a composite action, and bumping your own pin will
not silence it.

**A `v*` tag triggers two publishing workflows**, `release-binaries.yml` and `docker-publish.yml`
— so a "test tag" publishes a GHCR image, a cosign signature and a Trivy SARIF, none of which is
undone by deleting the release. To exercise the release build WITHOUT publishing, dispatch
`release-binaries.yml` from a branch: its `build` jobs have no tag gate and their artifacts are
downloadable from the run, while the `release` job self-skips on `startsWith(github.ref,
'refs/tags/v')`.

**Mutation testing.** `bun run test:mutate` runs [Stryker](https://stryker-mutator.io)
(`stryker.config.mjs`) against the backend test suite — it injects faults into the source and
checks that some test actually fails, proving the suite exercises behavior rather than merely
executing lines. It is heavier than `bun run test` (Bun's coverage report isn't natively
Stryker-readable, so every mutant re-runs the full suite via the `scripts/stryker-test-runner.ts`
wrapper) and is **not** part of `bun run check` or CI — run it as an occasional deep check, not a
per-commit gate. The multi-session hardening program that brought this to completion (P2 +
domains 2-10) is done: every file with meaningful runtime logic is effectively 100%
mutation-killed. `stryker.config.mjs`'s `mutate` array intentionally points at a single file
(`src/ws-proxy.ts`, the last one closed) as a stable placeholder for ad-hoc re-verification, not
an active target — scope it to whichever file you changed before re-running against new work. As
a byproduct of reaching that mutation-kill bar, the backend's `bun test --coverage` baseline sits
at ~97.6% functions / ~98.5% lines — the number `bunfig.toml`'s `coverageThreshold` (deliberately
set well below it) exists to guard against regressing, not to chase.

**`bun run check` can fail with a green test suite — that is the coverage gate, not a broken
test.** Its "root tests" step runs `bun test --coverage`, and Bun applies `coverageThreshold`
**per file**, not just to the global total. So one file under the floor fails the whole check
while every test passes, and the output reads `5286 pass / 0 fail` immediately followed by
`✗ root tests failed (exit 1)` — which sends you hunting for a failing test that does not exist.
Read the coverage table for the file below the line. The cheapest way to hit this is adding an
**unused** export to a new `src/__tests__/_utils/` module: one dead function put that file at 75%
functions while the global total was still 99.4%. Two consequences: don't add a shared test helper
before something calls it, and note `bun run test` (no `--coverage`) exits 0 in that state, so
reproducing needs `bun run test:coverage`.

## The e2e suite (`e2e/`)

`bun run test:e2e` boots the real stack — the built admin-ui served by the backend, a throwaway
SQLite file outside the repo, and a fake upstream (`e2e/support/fixture-server.ts`) — and runs
every spec. It is the only gate that exercises the SPA and the MCP wire protocol against a live
server, and it lives outside `bun run check` (CI runs it as its own required job).

**It is serial by construction, and that is a correctness property, not a performance choice.**
`workers: 1, fullyParallel: false`: every spec shares ONE backend process, ONE SQLite file, ONE
fixture upstream and ONE `maxSessions` budget. Three consequences that bite in non-obvious ways:

- **`00-auth-fail-closed.spec.ts`'s numeric prefix is load-bearing.** Its first assertion needs
  the data plane still in "open mode", i.e. that no managed MCP key exists yet — a whole-process
  property the first mint anywhere in the suite ends permanently. Playwright orders spec files by
  path, so it has to sort first. Don't rename it, and if the suite is ever reorganised into
  subdirectories, replace the prefix with an explicit project `dependencies` in the config rather
  than trusting path sort.
- **Release every MCP session.** `initMcpSession` registers each one; call
  `closeTrackedMcpSessions()` from your spec's `afterAll`. A leak subtracts from every LATER
  spec's headroom, and the resulting failure is non-local: some unrelated spec 503s with "Server
  at capacity" and nothing points back at the culprit. Measured once at 41 of 100 slots held.
- **Global fixture state has an owner.** The `/__control` down/up flag belongs to
  `circuit-breaker.spec.ts`; `/health` deliberately stays 200 even while "down", because the
  health loop would otherwise evict the client before its breaker could trip.

**Prove behaviour with upstream hit counts, not with the absence of an error.** `fixtureState()`
returns per-path request counts, and a delta is the only way to distinguish "the gate refused it"
from "it ran and then errored". A cache hit is a delta of ZERO; coalescing collapses N concurrent
calls to exactly 1; an open breaker must not reach upstream at all; a pending approval must not
execute the tool. Assert exact deltas against a snapshot taken immediately before the action —
never an absolute count, since the suite shares the fixture.

**Don't grow `fixtures/simple-openapi.json`** — backend unit tests assert on its exact discovered
tool set. `e2e/support/openapi-extended.ts` is the e2e-only superset (a failing endpoint, a
credential-leaking one, a slow one, an echo).

**Ambient rate limits are raised in `playwright.config.ts` on purpose** (logins, registrations and
MCP calls all share one bucket at 127.0.0.1), so the only limiting an assertion should ever
observe is a per-tool guard the spec configured itself.

**Local re-runs meet the previous run's database** (`reuseExistingServer` outside CI), so every
create tolerates a 409 and no assertion may depend on a row being new.

**Verify an accessibility finding against the browser's real accessible name** —
`locator.ariaSnapshot()` — before treating it as a defect. A native `<label>`, whether `for=` or
wrapping, DOES name a `button[role=combobox]` (accname step 2C, evaluated before the
name-from-content prohibition). Reasoning from the ARIA spec alone produced both a false positive
and a false negative here.

## Architecture

**The request path.** Every policy (rate limit, timeout, circuit-breaker override, allowed-key
restriction) is enforced at the **dispatch point**, `proxyToolCall()` in `src/proxy/proxy.ts` — never as
Express middleware. MCP multiplexes many tools over one `POST /mcp` route, so the bridge only
knows _which_ tool is being called once the JSON-RPC body is parsed; anything that needs per-tool
behavior has to live inside `proxyToolCall`, not `app.use(...)`.

**Three kinds of backend, one identity.** All are keyed the same way, `clientName__toolName`
(double underscore is the separator — client and tool names explicitly reject the `__`
separator at registration, so distinct pairs can't collide on this key):

- **REST clients** — registered from an OpenAPI/Swagger spec (auto-discovery via
  `src/discovery/`), a cURL/Postman import, or a manual tool list. Each tool maps to an HTTP
  method + path on the backend's base URL.
- **GraphQL clients** (`kind: "graphql"`) — the bridge introspects the schema and generates one
  tool per query/mutation. Dispatch reuses the REST path (each generated tool is a POST carrying
  the stored query), so `kind` here is identity/display only — but it must still be written:
  GraphQL registrations went through `persistRestRegistration` without one for a long time, took
  the `clients.kind` column default, and surfaced everywhere as REST.
- **MCP upstreams** (`kind: "mcp"`) — existing MCP servers (Streamable HTTP or SSE); the bridge
  connects out, discovers their tools/resources/prompts, and re-exposes them.

Every governance feature (guards, guardrails, RBAC, bundles, usage, audit) applies to all three
kinds unchanged because they share this identity.

**Two planes, three endpoints.** `POST /mcp` is the **control plane**: gateway management +
data retrieval over the gateway itself (`sys_*` tools — `src/mcp/system-tools.ts`), never
backend tools. There is no "everything flattened together" data mode any more — that
redundant aggregation (plus the legacy SSE transport, `GET /sse` + `POST /messages`, tied to
it) was removed. The **data plane** is two narrowing filters applied _before_ dispatch
(guards/breakers/SSRF behave identically regardless of which one a call came through):
per-client shard `/mcp/:clientName`, and curated bundle `/mcp-custom/:bundleName`
(admin-curated cross-client subset of tools and/or composite macros).

`/mcp` has its own fail-closed auth (`rootMcpAuth` in `src/middleware/auth.ts`, resolving the
caller's system role via `resolveSystemRole` in `src/security/system-role.ts`) — unlike the
data plane's `mcpAuth`, there is **no**
"no auth material configured => allow all" fallback; a caller must resolve to a real system
role (the env admin Bearer, or a managed `mcp_api_keys` row with `adminRole` set) or the
request is rejected outright. Each system tool additionally carries its own role tier
(read/operate/admin, mirroring `requireOperator`/`requireAdminRole`'s REST semantics) and may
require step-up (`{"__confirm": true}` or an elevated/env-bearer credential) — the same
mechanism `proxyToolCall`'s sensitive-tool gate already uses.

**Storage.** `bun:sqlite`, one file, no ORM, no external database. Admin config (enable flags,
guards, bundles, keys, audit, users, teams, policies, schedules...) lives here; the live registry
(`src/mcp/registry.ts`) is hydrated from it at boot. Schema changes are an **append-only** array
in `src/db/migrations.ts` (currently up to id 56) — never edit or renumber a shipped migration;
add a new one with the next sequential integer, written defensively (`CREATE TABLE IF NOT EXISTS`,
additive `ALTER TABLE`) since there's no down-migration mechanism.

**Security-critical invariants** (SSRF/DNS-rebinding protection): outbound fetches to a backend
must use `client.resolved_ip` (pinned at registration via `Bun.dns`, then re-validated on a TTL —
`refreshPinIfStale`/`IP_PIN_TTL_MS`, 5 minutes, in `src/net/ip-validator.ts` — re-resolving and
rejecting the request if the hostname now points at a private range), `redirect: 'error'`, and the
original hostname as the `Host` header. `health_url`, `base_url`, and
`openapi_url` are each validated independently through `validateBackendUrl` before registration.
Tool descriptions are sanitized (`sanitizeToolDescription`) before entering the registry
(prompt-injection defense). All credential comparisons (API keys, session hashes, CSRF tokens) go
through `src/security/compare.ts`'s `safeCompare` — never `===`.

**Resilience.** A background loop health-checks each client and auto-evicts unhealthy ones (ping
probe for MCP upstreams). Per-client circuit breakers (`closed → open → half_open`) trip on repeated
failures — including non-2xx HTTP responses, not just thrown exceptions — and must re-check
`canRequest()` before every retry. An optional canary/failover secondary can take over when a
primary breaker opens, without falsely closing the primary's breaker. Non-idempotent methods
(POST/PATCH) are never retried on failure; PUT/DELETE are retried only when the client opts in via
the per-client `retry_non_safe_methods` flag (off by default — see
`docs/guide/registering-backends.md`).

**Admin auth** (`src/middleware/auth.ts`): `adminAuth` tries a static Bearer key first,
unconditionally; only falls back to session-cookie auth when no `Authorization` header is present
at all, so existing Bearer/CI callers are never affected. Session-authenticated mutations require
a matching `X-CSRF-Token` header; Bearer calls are exempt. `mcpAuth` (guarding the data-plane
endpoints `/mcp/:clientName` and `/mcp-custom/:bundleName`) is Bearer-only, always — MCP clients
are programs, not browsers.

For the full request-path diagram and terminology, see `docs/guide/architecture.md` and
`docs/guide/concepts.md` (already written, keep them in sync with structural changes) — the
canonical feature list lives in `docs/guide/features.md`.

## Working in this repo

- Match the module layout already in place: route handlers in `src/routes/`, DB access in
  `src/db/`, security-sensitive logic in `src/security/`, dispatch/pipeline in `src/proxy/proxy.ts` +
  `src/middleware/`.
- TypeScript strict on both projects — avoid `any` and non-null assertions; prefer narrowing.
- Commit convention: `type(scope): summary` (`feat` / `fix` / `docs` / `chore` / `refactor` /
  `test`). Larger changes often land as a `feat` commit followed by `fix` hardening-pass commits;
  PR descriptions may use `[P0]`/`[P1]`/`[P2]` priority suffixes (correctness/security, robustness,
  polish) but they're not required.
- Manual admin-UI verification (login → dashboard → guard-edit → logout) needs
  `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD` set (only takes effect once, when
  `admin_users` is empty) and `ALLOW_PRIVATE_IPS=true` to register test clients at loopback
  addresses (SSRF protection otherwise correctly blocks them).
- **Prove a test discriminates: revert the fix and confirm it fails.** A test written against a
  bug you just fixed passes for two different reasons, and only one of them is the test working.
  This is cheap (`git stash push -- <src file>`, re-run, `git stash pop`) and it has changed the
  verdict here more than once — killing a "defect" that was never real, and resurrecting one that
  had been reasoned away.
- **A comment naming a version or a count is a liability.** The ones that cost the most time in
  this repo were not wrong code but confidently wrong prose: a CI comment claiming "12 specs" when
  there were 15, a `download-artifact@v4` note surviving the bump to v8, a `workflow_dispatch`
  fallback described in detail that the job's own `if` had made unreachable. Prefer comments that
  say WHY something is safe and WHAT would break it — those stay true through a version bump.
