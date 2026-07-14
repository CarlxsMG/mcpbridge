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

bun run check                        # everything CI checks, in one shot (scripts/check-all.ts):
                                      # format:check → lint (root) → lint (admin-ui) → i18n parity (admin-ui)
                                      # → typecheck (root) → test (root) → typecheck (admin-ui) → test (admin-ui)
                                      # → build (admin-ui)

bun run format:check && bun run lint # prettier --check + eslint, root only
tsc --noEmit                         # backend type-check
bun run test                         # backend tests (NOT bare `bun test` — see gotcha below)
cd admin-ui && bun run lint          # admin UI eslint
cd admin-ui && bun run typecheck     # admin UI type-check (vue-tsc -b --noEmit)
cd admin-ui && bun run test          # admin UI tests (vitest run)
cd admin-ui && bun run build         # admin UI production build (also type-checks)

bun test path/to/one.test.ts         # run a single backend test file directly (fine — scoping only breaks with no args)
bun run test:e2e                     # Playwright e2e (e2e/) — separate from `bun run check`, boots a real browser + backend
```

**Never run bare `bun test` (no args) from the repo root.** Bun's default test discovery
recurses the whole tree and matches both `*.test.ts` and `*.spec.ts`, so it also sweeps up
`admin-ui/src/**/__tests__/*.test.ts` (Vitest specs needing jsdom — fail with "document is not
defined" under bun's runner) and `e2e/*.spec.ts` (Playwright specs — fail with "Playwright Test
did not expect test() to be called here"). A positional filter like `bun test src` does **not**
scope correctly either, since bun matches it as a path substring and `"src"` also matches
`"admin-ui/src/..."`. Always use `bun run test`, which passes
`--path-ignore-patterns={admin-ui,e2e}/**`.

CI (`.github/workflows/ci.yml`) runs format-check/lint/typecheck/test/build on every push and PR;
`docker-publish.yml` publishes to GHCR on `v*` tags; `release-binaries.yml` builds standalone
binaries; `deploy-docs.yml` publishes the VitePress site in `docs/`.

## Architecture

**The request path.** Every policy (rate limit, timeout, circuit-breaker override, allowed-key
restriction) is enforced at the **dispatch point**, `proxyToolCall()` in `src/proxy/proxy.ts` — never as
Express middleware. MCP multiplexes many tools over one `POST /mcp` route, so the bridge only
knows _which_ tool is being called once the JSON-RPC body is parsed; anything that needs per-tool
behavior has to live inside `proxyToolCall`, not `app.use(...)`.

**Two kinds of backend, one identity.** Both are keyed the same way, `clientName__toolName`
(double underscore is the separator — the client/tool name regex is constrained so this can't
collide):

- **REST clients** — registered from an OpenAPI/Swagger spec (auto-discovery via
  `src/discovery/`), a cURL/Postman import, or a manual tool list. Each tool maps to an HTTP
  method + path on the backend's base URL.
- **MCP upstreams** (`kind: "mcp"`) — existing MCP servers (Streamable HTTP or SSE); the bridge
  connects out, discovers their tools/resources/prompts, and re-exposes them.

Every governance feature (guards, guardrails, RBAC, bundles, usage, audit) applies to both kinds
unchanged because they share this identity.

**Two planes, three endpoints.** `POST /mcp` is the **control plane**: gateway management +
data retrieval over the gateway itself (`sys_*` tools — `src/mcp/system-tools.ts`), never
backend tools. There is no "everything flattened together" data mode any more — that
redundant aggregation (plus the legacy SSE transport, `GET /sse` + `POST /messages`, tied to
it) was removed. The **data plane** is two narrowing filters applied _before_ dispatch
(guards/breakers/SSRF behave identically regardless of which one a call came through):
per-client shard `/mcp/:clientName`, and curated bundle `/mcp-custom/:bundleName`
(admin-curated cross-client subset of tools and/or composite macros).

`/mcp` has its own fail-closed auth (`rootMcpAuth`/`resolveSystemRole` in
`src/security/system-role.ts`) — unlike the data plane's `mcpAuth`, there is **no**
"no auth material configured => allow all" fallback; a caller must resolve to a real system
role (the env admin Bearer, or a managed `mcp_api_keys` row with `adminRole` set) or the
request is rejected outright. Each system tool additionally carries its own role tier
(read/operate/admin, mirroring `requireOperator`/`requireAdminRole`'s REST semantics) and may
require step-up (`{"__confirm": true}` or an elevated/env-bearer credential) — the same
mechanism `proxyToolCall`'s sensitive-tool gate already uses.

**Storage.** `bun:sqlite`, one file, no ORM, no external database. Admin config (enable flags,
guards, bundles, keys, audit, users, teams, policies, schedules...) lives here; the live registry
(`src/mcp/registry.ts`) is hydrated from it at boot. Schema changes are an **append-only** array
in `src/db/migrations.ts` (currently up to id 52) — never edit or renumber a shipped migration;
add a new one with the next sequential integer, written defensively (`CREATE TABLE IF NOT EXISTS`,
additive `ALTER TABLE`) since there's no down-migration mechanism.

**Security-critical invariants** (SSRF/DNS-rebinding protection): outbound fetches to a backend
must use `client.resolved_ip` (pinned once at registration via `Bun.dns`, never re-resolved),
`redirect: 'error'`, and the original hostname as the `Host` header. `health_url`, `base_url`, and
`openapi_url` are each validated independently through `validateBackendUrl` before registration.
Tool descriptions are sanitized (`sanitizeToolDescription`) before entering the registry
(prompt-injection defense). All credential comparisons (API keys, session hashes, CSRF tokens) go
through `src/security/compare.ts`'s `safeCompare` — never `===`.

**Resilience.** A background loop health-checks each client and auto-evicts unhealthy ones (ping
probe for MCP upstreams). Per-tool circuit breakers (`closed → open → half_open`) trip on repeated
failures — including non-2xx HTTP responses, not just thrown exceptions — and must re-check
`canRequest()` before every retry. An optional canary/failover secondary can take over when a
primary breaker opens, without falsely closing the primary's breaker. Non-idempotent methods
(POST/PUT/PATCH) are never retried on failure.

**Admin auth** (`src/middleware/auth.ts`): `adminAuth` tries a static Bearer key first,
unconditionally; only falls back to session-cookie auth when no `Authorization` header is present
at all, so existing Bearer/CI callers are never affected. Session-authenticated mutations require
a matching `X-CSRF-Token` header; Bearer calls are exempt. `mcpAuth` (guarding `/mcp`, `/sse`,
`/messages`) is Bearer-only, always — MCP clients are programs, not browsers.

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
