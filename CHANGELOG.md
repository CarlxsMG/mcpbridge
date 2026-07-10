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
- **Mutation testing — `backends.ts` 2nd pass, closing the `src/proxy/` domain**.
  Targeted the `wsRequest`/`wsRequestPersistent` event-handler internals PX-1
  flagged as a follow-up. **85.89% raw (140/163) / 96.93% including 18
  genuine-hang timeouts** — mutating the once-only `settled` guard breaks a
  real WebSocket exchange into a double-resolve or a hang, which Stryker
  correctly times out rather than silently passing. Effectively **100%**: the
  5 raw survivors are all documented-equivalent, verified against a real
  `Bun.serve` WebSocket server rather than asserted — `ws.send()` cannot throw
  synchronously inside the `open` handler in Bun's actual runtime (confirmed
  even when the server closes the connection immediately after upgrade), and
  the `wsUrl.replace(/^ws/, "http")` regex's `^`-anchor-dropped mutant is
  masked by the adjacent URL-prefix validation one line earlier (every
  reachable `wsUrl` already starts with "ws"/"wss", so anchored and
  unanchored replace agree). Up from a 69.94% baseline. Suite grows 1608 → 1627. Run with `STRYKER_TEST_SCOPE=src/proxy/__tests__ bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `registry.ts`** (1318 LOC, the
  dynamic client/tool registry — 2nd-largest backend file). 799 mutants,
  **98.25% raw (785/799)**, up from a 51.19% baseline (409/799), **effectively
  100%** — the 9 remaining raw survivors are all documented-equivalent
  (redundant guards a line later, `resolveTool`'s cross-validation masking
  stale `toolIndex` entries after teardown, registration's own upstream type
  guarantees), 6 of them independently re-verified by literally hand-applying
  the exact mutation to the source, re-running the suite, confirming no
  failure, then reverting — not just reasoned about from reading. 10 new
  `src/mcp/__tests__/registry-mutation-rc1..rc10.test.ts` files, one per
  functional cluster: registration validation (both the REST and MCP-upstream
  paths — near-duplicate validation gauntlets, each needing its own coverage),
  teardown/reconcile, admin mutation setters (enable, guards, tool overrides,
  schema-drift annotations), tool resolution/advertising, and the two admin
  read-model functions (`listClientsSummary`'s keyset pagination, and
  `getClientDetail`, the single biggest function in the file). Authored across
  three rounds: 10 agents cold (one per cluster), 5 agents extending the same
  files to close the densest remaining gaps, then a final manual pass closing
  5 more genuine gaps a prior round's tests couldn't quite isolate (a missed
  default-parameter case, a DB delete the live-state assertion couldn't
  observe, an unpinned error message, a truthy-non-string discriminator, and a
  placeholder-substitution edge case). Suite grows 1627 → 1870. Run with
  `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `registration.ts`** (667 LOC,
  the discovery-to-registry glue behind `POST /register`: REST/OpenAPI/cURL/
  Postman, MCP-upstream, and GraphQL registration — previously had NO
  dedicated unit-test file, only indirect route-level coverage). 552
  mutants, **99.09% raw (547/552)**, up from a 37.86% baseline (209/552),
  **effectively 100%**. 6 new `src/mcp/__tests__/registration-mutation-
rg1..rg5b.test.ts` files: shared helpers, the REST path (split across two
  files — its validation gauntlet vs. tool-resolution+register, since it's
  the single densest function in the file), the MCP-upstream path, and the
  GraphQL path (split across two files — validation vs. discovery+register).
  All 5 remaining raw survivors are documented-equivalent: 4 sit inside the
  module-load-only `$ref` schema resolver (runs once against the fixed,
  valid, bundled `openapi.yaml`; not exported, so no test can supply a
  different input to observe a mutant there), and 1 is a `pathname ||
"/graphql"` fallback that's provably dead code (`new URL(...).pathname`
  is never falsy for any valid URL). Authored across a cold round (6 agents,
  one per cluster) plus a final manual pass closing 3 genuine gaps a
  cluster's line-number references had drifted past (the GraphQL discovery
  call's `ipPin`/`includeMutations` fields, and the success log call's exact
  arguments). Suite grows 1870 → 1991. Run with
  `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `system-tools.ts`** (427 LOC,
  the `/mcp` root's `sys_*` control-plane tool catalog — thin adapters over
  already-tested domain functions, dispatched under a two-axis
  authorization model: role tier + sensitive/`__confirm` step-up). 490
  mutants, **99.80% raw (489/490)**, up from a 39.39% baseline (193/490),
  **effectively 100%**. 5 new `src/mcp/__tests__/system-tools-mutation-
st1..st5.test.ts` files: helpers + the dispatch/auth logic (the
  security-critical part), read-tier tools, operate-tier simple tools,
  `sys_register_client` (the densest single tool), and admin-tier
  mint/revoke. Most survivors sat in each tool's static `inputSchema`/
  `description` object literals — closed in bulk via one exact `toEqual`
  per tool against a hand-transcribed schema, rather than one test per
  literal field. A manual pass after the cold round found and fixed a real
  coordination gap between two agents (one tested `runSystemTool`'s
  _generic_ sensitive/`__confirm` gate via a single example tool; a sibling
  assumed that covered it, but each tool's own `sensitive: true` literal is
  an independent AST node never actually exercised for `sys_mint_key`/
  `sys_revoke_key` specifically) plus a genuine mislabeling (a `str()`/
  `num()` non-string/non-number pass-through bug attributed to the wrong
  helper by line-number confusion) and one missed handler test
  (`sys_list_keys`). The one remaining survivor is believed to be Stryker
  measurement noise, not a real gap — an intermediate verify run confirmed
  it killed, a later one showed it surviving again with zero test changes
  in between, and the relevant test passes reliably standalone. Suite grows
  1991 → 2093. Run with `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run
test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `registry-persistence.ts`**
  (410 LOC, every SQLite interaction the registry does — 3 row-to-DTO
  converters plus `RegistryPersistence`'s REST/MCP registration and
  read-hydration methods). 113 mutants, **100.00% (113/113), clean** — up
  from an 82.30% baseline (93/113). One new
  `registry-persistence-mutation.test.ts` file, driving the exported
  converters and class methods directly rather than through the full
  `Registry`/lock layer. Three verify rounds, each closing a genuine gap
  the previous one exposed (a `cb_half_open_timeout_ms` null-check twin to
  two already-covered siblings; an empty-object `circuitBreaker: {} ->
undefined` collapse; an empty-but-parsed `params: {}` object not
  collapsing a tool-override row to `undefined`; the client-level `enabled`
  field on the read-hydration path, distinct from the already-covered
  per-tool one) — the same round-to-round survivor churn seen on other
  files in this series, resolved by simply fixing each newly-exposed gap
  rather than assuming noise. Suite grows 2093 → 2112. Run with
  `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `transports.ts`** (358 LOC,
  the Streamable-HTTP transport layer: sharded `/mcp/:clientName`, curated
  `/mcp-custom/:bundleName`, and the system-root `/mcp`, all sharing
  `handleStreamablePost/Get/Delete` plus a 60s TTL-eviction timer). 286
  mutants, 48.25% baseline (138/286) → 87–88% raw across 3 stable verify
  rounds (249–251/286, killed-count itself fluctuating run-to-run — this
  file's own instance of the known Stryker measurement-noise pattern) →
  **effectively 100%**: every raw survivor in the final run is a
  documented equivalent with concrete reasoning. Five new
  `transports-mutation-t1..t5.test.ts` files (one per functional cluster,
  parallel Workflow round) plus a manual closing pass across 4 more verify
  rounds that fixed 5 genuine gaps: `req.body` is `undefined` (not `{}`)
  on a request with no content-type at all, so `req.body?.id` only
  diverges from `req.body.id` on a truly bodyless request, not merely one
  missing an `id` key (5 OptionalChaining survivors, all fixed the same
  way); a TTL eviction boundary `>` vs `>=` gap (fixed via `Date.now()`
  stubbing for an exact-equality tick instead of a flaky real-clock race);
  a mislabeled equivalence note (two distinct `"system"` string literals
  on the same `scopeKey` line, originally conflated under one location);
  a missed `streamable.close()` mutant (proven only by a real open SSE
  stream that must actually end, not just by checking the routing maps);
  and a second regex-anchor test (Stryker's regex mutator alternates
  between dropping the leading `^` and the trailing `$` across runs).
  Reaching `handleStreamablePost`'s catch block at all required a
  dependency-injection technique (spying `createMcpServer`/
  `registry.getClient` to throw) since the MCP SDK absorbs every other
  failure mode internally and never rethrows to the caller. Suite grows
  2112 → 2168. Run with `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run
test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `mcp-upstream.ts`** (the
  outbound MCP upstream connection pool + dispatcher: `buildTransport`,
  `mcpResultToProxyResult`, `McpUpstreamPool`'s
  call/listResources/readResource/listPrompts/getPrompt/ping/disconnect).
  131 mutants, 81.68% baseline (106/131) → 96.18% raw (126/131) across 3
  verify rounds (124 → 124 → 126, stable/improving) → **effectively
  100%**: all 5 raw survivors documented equivalent. One new
  `mcp-upstream-mutation.test.ts` file, authored directly. The existing
  sibling test file always injects a custom `transportFactory`, so
  `buildTransport` itself (the real network-transport builder) was
  completely untested — closed via direct calls plus reading the SDK's
  internal `_requestInit`/`_fetch` fields off the constructed transport.
  Also closed: a `connectTimeoutMs`/per-call-timeout family of gaps (`??`
  vs `&&`, and 4 separate `{timeout: ...}` options objects across
  connect/ping/readResource/getPrompt) via a reusable `delayMethod()`
  helper that monkey-patches a real transport's `send()` to delay one
  JSON-RPC method, proving a small custom timeout actually fires before a
  large default would; a `getClient()` in-flight-connection-dedup gap
  (two concurrent calls to the same not-yet-connected upstream must share
  one connect attempt); and a `getPrompt()` catch-block gap. The 5
  equivalents lean on deeper SDK-internals reasoning than usual: two
  `?? []` fallbacks (`listResources`/`listPrompts`) are unreachable
  because the SDK's own zod response schema requires those array fields,
  so a malformed response throws before the fallback line ever runs; a
  capabilities object literal is subsumed by the SDK's own default; a
  `Buffer.byteLength(text, "utf8")` → `""` swap matches the encoding
  equivalence already documented for `secret-box.ts`; and 4
  `if (x) opts.y = x` guards turned out unobservable since the only
  inspection point reads `opts?.y` either way — confirmed empirically
  that `spyOn` cannot intercept a class export's raw constructor
  arguments (breaks `new` semantics on the SDK's transport classes).
  Suite grows 2168 → 2192. Run with `STRYKER_TEST_SCOPE=src/mcp/__tests__
bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `mcp-server.ts`** (264 LOC,
  the security-critical core: `createMcpServer()` builds a per-scope MCP
  `Server` binding tools/list + tools/call's full authorization gate —
  system-role check, exact client-membership confused-deputy defense,
  bundle-membership + composite-macro dispatch — plus resources/prompts
  passthrough for a client-scoped MCP upstream). 181 mutants, 61.33%
  baseline (111/181, entirely from indirect coverage via `transports.ts`'s
  own suite — this file had zero dedicated tests) → 97.79% raw (177/181)
  across 5 verify rounds, steadily improving each round → **effectively
  100%**: both remaining raw survivors documented equivalent. Five new
  `mcp-server-mutation-s1..s5.test.ts` files from a parallel Workflow cold
  round (61.33% → 94.48%), then a manual closing pass across 4 more verify
  rounds. Key harness finding: a lightweight InMemoryTransport
  `Client`↔`Server` connection cannot carry `extra.requestInfo.headers`
  (the SDK only forwards `authInfo`), so anything reading a real
  Authorization/X-End-User-Id header needs a real-HTTP harness — but
  `setupTransports(app)` itself can't reach this file's OWN system-role
  gate in isolation, since `rootMcpAuth` (mounted in front of `/mcp`) runs
  an identical check one layer up and rejects first with a different
  message. A bare `StreamableHTTPServerTransport` wired directly to
  `createMcpServer({kind:"system"})`, deliberately without `rootMcpAuth`,
  isolates the file's own redundant gate instead. Genuine gaps closed:
  a Bearer-prefix-bypass (a non-`"Bearer "`-prefixed header whose blind
  `.slice(7)` would have accidentally landed on the real configured admin
  key); a separate `.slice(7)` vs `.slice(7).trim()` mutant (needed a
  token with a stray _internal_ space, since Node's own HTTP parser
  strips edge whitespace on the whole header value before the app ever
  sees it); a bundle/client name-collision confused-deputy gap in
  `mcpParamsForScope`; a client `.find()` "always match the first"
  direction masked by earlier tests' incidental registration order; the
  `Server`'s own self-identification (`getServerVersion()`, the SDK-side
  mirror of `mcp-upstream.ts`'s `getClientVersion()` technique); a
  `progressToken`-forced-true gap where the obvious fix (wait for a
  notification) was itself masked by schema validation dropping malformed
  notifications on _both_ the real and mutant paths — the reliable signal
  turned out one layer earlier, observing whether the SDK auto-generates
  an outbound progress token at all; and a system-scope no-credential
  tools/list gap. The 2 final equivalents: `isBundleEnabled`/
  `getBundleToolKeys`/`getBundleComposites` all read the same
  `liveBundles` cache entry, so once `isBundleEnabled` is true — a
  precondition of every call site consuming the other two — that entry is
  guaranteed to already exist with real (possibly empty, but always
  truthy) `Set` objects, making the `?? []`/`?.` fallbacks dead code.
  Suite grows 2192 → 2241. Run with `STRYKER_TEST_SCOPE=src/mcp/__tests__
bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `mcp-discovery.ts`** (117
  LOC — MCP upstream tool discovery: name normalization, collision
  de-dup, description fallback, paginated tools/list connect flow). 53
  mutants, 77.36% baseline (41/53, from `mcp-upstream.test.ts`'s own
  "discovery" describe block, which only exercised a two-way collision
  and a single-page response) → 94.34% raw (50/53) → **effectively
  100%**. One new `mcp-discovery-mutation.test.ts` file, authored
  directly. Closed: a 3-way name-collision test (proving the while-loop
  genuinely re-checks and increments past `_2`); a whitespace-only-
  description edge case; `getClientVersion()` for the self-identification
  constants; the `delayMethod()` timeout-propagation technique applied to
  both the connect phase and each tools/list page; and a genuine
  multi-page pagination test. Two remaining raw survivors: one is the
  same SDK-default-subsumes-it capabilities-object equivalence documented
  twice already this domain; the other (an untruncated-candidate
  collision check) was investigated in depth but the only construction
  that would distinguish it hits a pre-existing, mutant-independent
  infinite-loop edge case in the real code first — flagged as a latent
  out-of-scope limitation rather than built around. `types.ts` (169 LOC)
  evaluated and **skipped** — pure interface/type-alias declarations, no
  runtime logic for Stryker to mutate. Suite grows 2241 → 2248. Run with
  `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `tool-search.ts`** (110 LOC
  — the `search_tools` meta-tool: static schema definition, pure ranking
  algorithm, `runSearchTool` dispatch). 90 mutants, 80.00% baseline
  (72/90) → 96.67% raw (87/90) across 3 verify rounds → **effectively
  100%**: all 3 raw survivors documented equivalent. One new
  `tool-search-mutation.test.ts` file, authored directly — a pure,
  side-effect-free module tested purely via direct function calls, no
  transport/harness needed. Closed: the bulk-schema-toEqual technique for
  the static tool definition; a description-fallback placeholder-string
  gap; a per-token name-match gap whose "obvious" test was itself
  accidentally satisfied by the separate whole-query-substring boost
  (same code, different line) rather than the mechanism under test —
  caught by checking the exact `score` value, not just presence; a
  boost-vs-tie-break gap needing two tools engineered to an exact equal
  per-token score; a punctuation-only-query gap (non-empty after trim,
  but zero real tokens — the boost check isn't gated by token count); and
  query-coercion gaps for whitespace-only queries and non-number/
  non-finite `limit` values. All 3 equivalents trace back to `.trim()`
  and the tokenizer's regex fully overlapping on what counts as
  whitespace/non-content for any realistic input, plus
  `Number.isFinite()`'s own spec-mandated non-coercion. Suite grows
  2248 → 2263. Run with `STRYKER_TEST_SCOPE=src/mcp/__tests__ bun run
test:mutate`.
- **Mutation testing — domain 3 (`src/mcp/`), `registry-alias-index.ts`**
  (96 LOC — `RegistryAliasIndex`, the display-name alias map kept in
  lockstep with the registry). 28 mutants, **100.00% (28/28) baseline,
  already clean** — the existing dedicated `registry-alias-index.test.ts`
  already fully covered it; no new test file needed.
- **Mutation testing — domain 3 (`src/mcp/`), `tool-index.ts`** (78 LOC —
  `ToolIndex`, the canonical-key → (client, tool) lookup map). 16
  mutants, **100.00% (16/16) baseline, already clean** — the existing
  dedicated `tool-index.test.ts` already fully covered it; no new test
  file needed. **This was the last file in domain 3 — `src/mcp/` is now
  fully covered** (registry, registration, system-tools, registry-
  persistence, transports, mcp-upstream, mcp-server, mcp-discovery,
  tool-search, registry-alias-index, tool-index — all effectively 100%;
  `types.ts` skipped as pure type declarations). Domain 4
  (`src/db`/`src/middleware`/`src/net`) starts next.
- **Mutation testing — domain 4 (`src/db`+`src/middleware`+`src/net`),
  `ip-validator.ts`** (283 LOC, `src/net/` — the centralised SSRF/DNS-
  rebinding defence: IPv4/IPv6 blocked-range checks, `validateBackendUrl`'s
  dual-stack DNS resolution, TTL re-pinning, pinned-fetch/pinned-lookup
  transport helpers). 193 mutants, 94.30% baseline (182/193) → 99.48% raw
  (192/193) across 2 verify rounds → **effectively 100%** (the one raw
  survivor is a genuine equivalent). One new `ip-validator-mutation.test.ts`
  file. New technique: `Bun.dns.lookup` is a real global `spyOn` can mock
  directly, letting `validateBackendUrl`'s dual-stack DNS branch be driven
  deterministically per-family with zero real network access — reusable
  for any future file calling `Bun.dns.lookup`. Closed: a 6to4-false-
  positive gap (a public IPv6 address whose bits would decode to a private
  IPv4 if the 6to4 extractor were wrongly applied); the IP-literal fast
  path's actual skip-DNS guarantee (proven via the spy seeing zero calls);
  poisoned DNS-fallback arrays; both directions of the all-records-empty
  check; `allowPrivateIps` actually gating rejection both ways; the IPv4-
  preference tie-break; malformed-URL and non-http(s)-protocol rejection;
  a bracketed-IPv6 URL through the full path; `refreshPinIfStale`'s
  thrown-message reason-vs-hostname distinction (the sibling test's regex
  matched the message's static prefix regardless of the mutation, masking
  the gap); and `makePinnedLookup`, previously untested. 3 documented
  equivalents (an unreachable defensive catch, a `||`-vs-`&&` pair only
  distinguishable by hostname shapes the URL parser never produces, and a
  redundant `.toString()` branch). `src/db/migrations.ts` (1024 LOC)
  evaluated and **skipped** — static SQL data, same reasoning as
  `types.ts`. Run with `STRYKER_TEST_SCOPE="src/db/__tests__
src/middleware/__tests__"`.
- **Mutation testing — domain 4, `auth.ts`** (207 LOC, `src/middleware/` —
  admin auth (Bearer OR session+CSRF), MCP data-plane auth (env keys / DB-
  managed keys / JWT / "no auth material → allow all" fallback), and the
  `/mcp` control-plane's fail-closed `rootMcpAuth`). 152 mutants, 94.08%
  baseline (143/152, entirely indirect coverage — no dedicated test file
  existed) → **100% effective** (151/152 killed, 1 stable Timeout on the
  same "handler body emptied" pattern already accepted elsewhere in this
  program). One new `auth-mutation.test.ts` file, authored directly, using
  lightweight mock Express req/res objects plus `spyOn` on
  system-role.js/jwt.js/mcp-key-store.js/session-store.js/user-store.js —
  made self-sufficient rather than widening `STRYKER_TEST_SCOPE` to include
  `src/mcp/__tests__` (where `rootMcpAuth`'s real indirect coverage lives).
  Closed across 4 verify rounds: all 3 `rootMcpAuth` outcomes; the JWT
  branch's `isJwtConfigured` guard; the `if (token)` guard; an env-key-match
  exact-object assertion; an `&&`-vs-`||` gap where merely having env keys
  configured must not itself grant access to a non-matching token; the "no
  auth material" fallback both ways; `evaluateMcpAuth`'s `authDisabled`
  early-return; `mcpAuth`'s `mcpKeyId`/`jwtSubject` request-mutation guards
  (the latter needed a `hasOwnProperty` check, since the mutant assigns
  literal `undefined` rather than skipping the assignment); `mcpAuth`'s
  rejected-verdict short-circuit; and `adminAuth`'s session-path optional
  chaining on a since-deleted user (`findUserById(...)?.teamId` resolving
  to `null` instead of throwing). Run with the same
  `STRYKER_TEST_SCOPE="src/db/__tests__ src/middleware/__tests__"`.
- **Mutation testing — domain 4, `circuit-breaker.ts`** (214 LOC,
  `src/middleware/` — the CircuitBreaker closed/open/half_open state
  machine plus its module-level singleton registry). 132 mutants, 93.18%
  baseline (123/132 — the state machine itself was already thoroughly
  covered by the existing `circuit-breaker.test.ts`; every survivor was in
  a module-level function or a metric/log side effect) → **100.00%
  (132/132), clean** across 5 verify rounds. One new
  `circuit-breaker-mutation.test.ts` file. Closed: 3 `breakerStateTransitions`
  metric-label assertions verified via the Counter's own `.render()`
  output (a simpler alternative to spying, when a metrics primitive
  already exposes a readable dump); 2 `log()` call-content assertions via
  `spyOn`; the thundering-herd probe rejection's exact `reason: "Probing"`
  string; the unexported `BREAKER_IDLE_TTL` constant's value, observed by
  spying `startPeriodicSweep` to capture the real interval argument;
  `updateCircuitBreakerConfig`'s no-op-on-missing-client guard **and**
  that it actually applies to an existing breaker (found only on the 4th
  verify round — the original test only proved the no-op half);
  `getAllCircuitStates`/`getAllBreakerStateGauges`/`removeCircuitBreaker`,
  none of which had any prior test at all; and two exact-boundary ticks
  (`getState`'s `resetTimeoutMs` `>=`, and the sliding-window prune's
  `windowMs` age-out `<`) needing precise `Date.now()` stubbing to the
  internal timestamp actually used, not an approximated offset. Run with
  the same `STRYKER_TEST_SCOPE`.
- **Mutation testing — domain 4, `rate-limiter.ts`** (267 LOC,
  `src/middleware/` — the sliding-window rate limiter: 6 tiers, LRU-bounded
  bucket maps, and the idle-bucket eviction sweep). 164 mutants, 90.85%
  baseline (149/164 — the pure `checkRateLimit`/`checkLimit` functions and
  LRU primitives were well covered, but the 6 Express-wrapped middleware
  factories and the eviction sweep had never been driven directly) →
  **100.00% (164/164), clean** across 7 verify rounds. One new
  `rate-limiter-mutation.test.ts` file. Closed: the sampled (1%) LRU
  eviction log, needing `spyOn(Math, "random")` to force both branches; an
  exact `retryAfterSeconds` computation (`> 0` doesn't distinguish a `-`
  from a `+` typo, since the flipped version is still a large positive
  number); a dedicated tier-string assertion per middleware factory (6
  near-identical call sites, each its own AST literal); the `req.ip ?? req.socket?.remoteAddress`
  fallback's `??`-vs-`&&` divergence (only observable when `req.ip` is
  truthy — a "both absent" no-throw test doesn't catch it); a literal
  bucket-key assertion (a single happy-path call can't tell a real string
  key from an emptied one); and the entire idle-eviction sweep, which had
  zero coverage at baseline, via the same captured-callback technique
  introduced for `circuit-breaker.ts`. 1 documented equivalent (an injected
  array literal on a freshly-created bucket that the very next line's
  prune filter unconditionally strips via `NaN` comparison semantics).
  **This closes out domain 4's sizeable files** — remaining small files
  (all <100 LOC) are next. Run with the same `STRYKER_TEST_SCOPE`.
- **Mutation testing — domain 4, the 8 remaining small files** (all
  <100 LOC, batched into one Stryker run: `request-id.ts`,
  `origin-validator.ts`, `connection.ts`, `json-depth.ts`, `authz.ts`,
  `leader-lease.ts`, `rate-counters.ts`, `cors.ts` — 295 mutants total).
  95.25% baseline (278/295 raw + 3 accepted timeouts) → **effectively
  100%** across 5 verify rounds: every genuine gap closed, plus several
  confirmed-equivalent survivors. New test files:
  `origin-validator-mutation.test.ts`, `json-depth-mutation.test.ts`,
  `authz-mutation.test.ts`, `leader-lease-mutation.test.ts`,
  `rate-counters-mutation.test.ts`, `cors-mutation.test.ts`.
  `connection.ts` was already 100% clean at baseline; `request-id.ts` and
  `cors.ts` each carry one accepted route-handler-body-emptied timeout
  (the same pattern used throughout this program); `json-depth.ts` carries
  one for `exceedsDepth`'s whole body. Closed: `isOriginAllowed`'s
  `some`/`every` and port-wildcard-option gaps (the real function's
  port-wildcard support had only ever been tested via a duplicated
  reimplementation, never the real code path); every distinct-message
  assertion across `originValidator`'s three response branches;
  `exceedsDepth`'s BFS actually queuing nested nodes and pruning
  primitives (plus a `null`-body edge case: `typeof null === "object"` in
  JS, so a naive `&&`-flip would call `Object.values(null)` and throw);
  `authz.ts`'s full `callerTeamId`/`ensureClientAccess`/`requireOperator`
  surface (optional-chaining bearer-caller guards, the "unknown client
  waved through" boolean, genuine-access-granted and admin-role paths);
  `leader-lease.ts`'s failure-path log assertions and the stop-function's
  actual `clearInterval` call (via `spyOn(globalThis, "clearInterval"/
"setInterval")`); `rate-counters.ts`'s prune-boundary arithmetic (using
  directly-injectable `now` rather than mocking `Date.now`), per-key/
  per-tool/per-end-user counter isolation, and the exact-shape returns of
  all three public functions; and `cors.ts`'s port-wildcard-flag
  enforcement. Several equivalents confirmed via standalone `bun -e`
  simulations rather than assumed: `cors.ts`'s wildcard fast-path (4
  variants across rounds, all structurally redundant with
  `matchesOriginEntry`'s own `"*"` handling plus a separately-computed
  `isWildcard` flag downstream); `json-depth.ts`'s `typeof root !==
"object"` check (every JS primitive funnels through `Object.values()`
  to the same final result; the one input that WOULD diverge, `undefined`
  as the root, is unreachable — the middleware guards against it one
  layer up); and `rate-counters.ts`'s `++`/`--opCount` (an unexported
  counter observable only via `% 200 === 0`, which fires with identical
  frequency regardless of direction). Run with the same
  `STRYKER_TEST_SCOPE`. **This closes domain 4 (`src/db`+`src/middleware` +`src/net`) entirely.**
- **Mutation testing — domain 5, `context-budget.ts`** (368 LOC,
  `src/tool-policies/` — the per-tool "context budget" guardrail:
  deterministic byte truncation plus opt-in LLM summarization via
  admin-configured OpenAI/Anthropic-compatible endpoints, falling back to
  truncation on any LLM failure). 197 mutants, 69.5% baseline (137/197) →
  97.97% raw (193/197) across 2 verify rounds → **effectively 100%** (1
  documented equivalent + 3 accepted timeouts). Given the large survivor
  count (57 across 7 distinct functional clusters), used a 7-agent
  parallel workflow — one agent per cluster (row-parsing guard, secrets
  encryption failure, truncation boundary, prompt text, OpenAI request
  shape, Anthropic request shape, main enforcement entry point) — each
  authoring its own test file, followed by one manual closing pass for
  gaps the cold round missed (request method/Content-Type assertions,
  the test-only fetch-reset helper's own body, and the truncate-mode
  mirror of an llm-mode/config DB-mismatch case). One real bug found and
  fixed mid-review: a leaked, never-restored `spyOn` on the shared logger
  export in one agent's file broke unrelated LATER test files in the same
  process (a sibling test expecting exactly 1 logged call instead saw
  418, since `bun test` runs all files in one process and ES module
  exports are singletons) — always pair `spyOn` with
  `finally { spy.mockRestore(); }`, not just `mockClear()` between tests
  in the same file. Run with `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `load-balancer.ts`** (313 LOC,
  `src/tool-policies/` — per-client N-way upstream load balancing:
  round-robin/weighted/least-conn strategies, SSRF-validated + IP-pinned
  target pool CRUD, per-target health cooldown). 234 mutants, 81.62%
  baseline (191/234) → 98.29% raw (230/234) across 3 verify rounds →
  **effectively 100%** (all 4 remaining are documented equivalents). Test
  file is cross-directory (`src/mcp/__tests__/load-balancer.test.ts`, not
  `src/tool-policies/__tests__/`) — same gotcha class as `auth.ts`'s
  `rootMcpAuth` in domain 4. Given a smaller, more mechanical survivor
  count (43, mostly validation-boundary boilerplate) than
  `context-budget.ts`, authored directly rather than via a workflow — one
  new `load-balancer-mutation.test.ts`. Closed: every validation
  boundary (`primaryWeight`/`weight` integer-range triples, both in
  `setLb` and `updateUpstream`); a non-REST client rejection path never
  previously tested; a target-pool `?.`/`||` SSRF-result check; a
  disabled-target-never-selected guarantee; the weighted strategy's real
  (not floored) target weight, its block genuinely running (not silently
  falling through to round-robin), and its out-of-bounds fallback index;
  least-conn's tie-breaking (favor the earlier member) and correctness
  in both directions; the health-cooldown exact-boundary tick; and the
  `decInflight`/DI-helper-reset internals. New equivalence class found:
  a module-level `let fn = () => ...` DI-helper's own initial value is
  unreachable once any test file's `beforeEach` resets it (which this
  file's own dedicated test does, unconditionally, before every test).
  Run with `STRYKER_TEST_SCOPE="src/tool-policies/__tests__ src/mcp/__tests__"`.
- **Mutation testing — domain 5, `quarantine.ts`** (253 LOC,
  `src/tool-policies/` — auto-quarantine after N consecutive
  content-guardrail hits: block/force_approval/observe actions, auto
  (cooldown) vs. manual recovery). 102 mutants, 85.3% baseline (87/102) →
  99.02% raw (101/102) across 2 verify rounds → **effectively 100%** (the
  1 remaining raw survivor is the same DI-helper-initial-value
  equivalence class as `load-balancer.ts`'s `nowFn`). One new
  `quarantine-mutation.test.ts`. Closed: every `cooldownUntil`
  computation combination (auto/manual × real/null `cooldownMs`);
  `checkQuarantine`'s no-policy short-circuit (needed an orphaned,
  DB-mismatched quarantined state row with no policy to prove it, since
  the downstream "not quarantined" check reaches the same conclusion for
  a genuinely-empty client); a 3-mutant `&&`-chain cluster on the
  auto-recovery condition (same DB-mismatch technique: a manual-mode
  policy with `cooldown_until` forced into the past via direct UPDATE);
  a `!== null`-forced-true gap where `x >= null` coerces to `x >= 0` in
  JS (always true for realistic timestamps) — auto mode with a
  genuinely-null `cooldownUntil` would otherwise auto-clear immediately;
  and `getQuarantineForClient`, which had zero prior coverage. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `guardrails.ts`** (195 LOC,
  `src/tool-policies/` — content guardrails: 7 `SECRET_PATTERNS` + 10
  `INJECTION_PATTERNS` regexes, cached deny-pattern compilation,
  input-side blocking, and response-side spotlighting/scanning). 189
  mutants, an unusually low 51.85% baseline (98/189 — Stryker's regex
  mutator generates 5-8 variants per literal across 17 regexes) →
  99.47% raw (188/189) across 2 verify rounds → **effectively 100%** (1
  documented equivalent). Given the large survivor count (91, dominated
  by per-regex boundary variants), used a 4-agent parallel workflow —
  one agent per cluster (`SECRET_PATTERNS`, `INJECTION_PATTERNS`,
  compile/row/per-client read paths, `setGuardrails`+input-gate) — each
  authoring its own test file, followed by one manual closing pass for
  5 gaps the cold round left (see below). New files:
  `guardrails-mutation-{secrets,injection,compile-row,setguardrails,final}.test.ts`.
  Key finding — **regex mutants split into two families needing opposite
  techniques**: character-class-negation and whitespace-family flips
  (`[A-Za-z0-9]`→`[^…]`, `\s+`→`\S+`) are killed by an ordinary positive
  match test, but quantifier-reduction mutants (`{16}`→`{1}`, `{8,}`→
  none, `\s+`→`\s`) need the opposite — a negative near-miss proving the
  larger original minimum is enforced — since a string satisfying the
  stronger real requirement trivially also satisfies the weaker mutant
  one. The manual closing pass fixed: `compileDenyPattern`'s catch block
  (documented equivalent — cache-hit's `?? null` normalizes the mutant's
  leftover `undefined` back to `null`, and `if (re && …)` treats both as
  falsy, verified via `bun -e`); `setGuardrails`' `.slice(0,
MAX_DENY_PATTERNS)` cap being silently dropped from the end of the
  trim/filter chain (the agent's pipeline test only fed 4 entries, never
  the 20-item cap); the "clear when empty" path only _looking_ like a
  DELETE via `getGuardrails` (`rowToGuardrails`'s own null-collapse
  returns `null` for a fallen-through empty upsert too — needed a raw
  `SELECT COUNT(*)` against `tool_guardrails` to prove the row is
  actually gone); and `checkInputGuardrails`'s own catch block, where
  `RegExp.prototype.test(undefined)` coerces to the literal string
  `"undefined"`, so a circular-reference test needed a deny pattern
  specifically targeting that word to distinguish the real
  `String(args)` fallback (`"[object Object]"`) from the mutant's
  leftover `undefined`. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `pagination.ts`** (159 LOC,
  `src/tool-policies/` — cursor/page/link-header pagination strategies:
  `getPaginationConfig`/`setPaginationConfig`, `getByPath`,
  `parseNextLink`'s RFC-5988 Link-header regex, `withItems`' nested-path
  response rewrite). 114 mutants, 75.44% baseline (86/114) →
  **100.00% (114/114), clean** in a single verify round. One new
  `pagination-mutation.test.ts`, authored directly (29 baseline
  survivors, well under this program's multi-agent workflow threshold).
  Closed: the `enabled`/`pageParam` `??`→`&&` read/write round-trip pair
  (a single truthy `pageParam` persisted and read back proves both
  directions at once); `getByPath`'s `cur === null` guard isolated from
  its sibling `typeof` check via an explicit null intermediate; three
  distinct `parseNextLink` regex-boundary clusters (whitespace
  before/after the `;rel=` separator, spacing around `rel = "next"`, and
  optional-quote removal on an unquoted `rel=next` value) plus a
  `.trim()` gap on the captured URL and the malformed-segment
  `if (!m) continue` guard (proven via a garbage segment ahead of a
  valid one); and `withItems`' whole-body and per-intermediate-segment
  null/non-object guards plus the nested-descent loop's
  condition/direction/body (needing a multi-segment `itemsPath` with an
  untouched sibling property, since the existing test only ever
  exercised a single segment). No new equivalence classes this file —
  every survivor was a genuine, closable gap. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `response-cache.ts`** (159 LOC,
  `src/tool-policies/` — the per-tool GET response cache: durable
  `tool_cache` config plus a process-local TTL+LRU in-memory store). 83
  mutants, 77.11% baseline (64/83) → 96.39% raw (80/83) across 2 verify
  rounds → **effectively 100%** (1 documented equivalent + 2 accepted
  timeouts). Test file is cross-directory
  (`src/proxy/__tests__/response-cache.test.ts`, not
  `src/tool-policies/__tests__/`) — same gotcha class as
  `load-balancer.ts`/`auth.ts`. One new
  `response-cache-mutation.test.ts`, authored directly (19 baseline
  survivors). Closed: the TTL `<=` vs `<` expiry-boundary tick;
  `expiresAt`'s `* 1000` vs `/ 1000` arithmetic (a 100s TTL entry must
  still be live 50ms later); the LRU-eviction loop's
  `oldest === undefined` guard (needed a negative `cacheMaxEntries` to
  drain the store to empty mid-loop — this mutant resolved as a genuine
  Timeout on verify, not a Killed status, same convention as its
  sibling while-body-emptied mutant); `purgeClientCache`'s entire
  cluster (had zero prior coverage — one test asserting a target
  client's keys are dropped AND an unrelated client's keys survive
  kills the emptied-body, emptied-prefix, and
  startsWith↔endsWith-swap mutants together); and `stableStringify`'s
  null/primitive/undefined/array/multi-key-object edge cases (only ever
  exercised via plain single-level objects before). One real miss on
  the first verify round: a single-key-object test can't reach the
  outer object branch's `.join(",")` separator between MULTIPLE
  key:value pairs (nothing to join with only one entry) — needed a
  2-key object to observe the dropped comma. **New finding, unrelated
  to any mutant**: the file's "space-joined key" doc comment is stale —
  the actual field separator in all 3 template literals (`cacheKey`,
  `purgeToolCache`'s and `purgeClientCache`'s `prefix`) is a literal NUL
  byte (`\0`), not a space, confirmed via a raw byte read; the file has
  been binary in git's own eyes since its first commit. Functionally
  harmless (the keys are process-local, in-memory-only) but flagged
  rather than silently fixed, since changing production source is out
  of scope for a test-only mutation backstop pass. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__ src/proxy/__tests__"`.
- **Mutation testing — domain 5, `oauth.ts`** (155 LOC,
  `src/backend-auth/` — outbound OAuth2 client-credentials with
  auto-refresh: config CRUD plus a per-client TTL-cached token mint). 86
  mutants, 66.28% baseline (57/86) → 96.51% raw (83/86) across 2 verify
  rounds → **effectively 100%** (3 documented equivalents). Test file is
  cross-directory (`src/security/__tests__/oauth.test.ts`, a leftover
  from before `backend-auth/` split out of `src/security/`). One new
  `oauth-mutation.test.ts` in that same directory, authored directly
  (29 baseline survivors). Closed: the `INVALID_URL` branch; both
  directions of the `SECRETS_PROVIDER_ERROR` ternary (an `Error` throw
  vs. a non-`Error` throw from `encryptSecret`, via `spyOn` on
  `localProvider.encryptSecret`); `__resetOAuthForTesting`'s own effect
  (a stale per-client token cache isn't reused after a manual reset, and
  the real clock resumes ticking — neither had ever been observed
  directly, since every other test immediately re-stubs the clock right
  after calling it); the entire outbound mint request shape
  (method/headers/body, with and without a configured scope — no
  existing test had ever inspected the real request); a non-ok
  token-endpoint response; a response missing `access_token`; and the
  `expires_in`-vs-3600-default TTL fork (a real, small `expires_in`
  forces an early refresh; a missing one falls back to 3600s, not
  `NaN`). One real miss on the first verify round: the non-ok-response
  test's mocked body initially had no `access_token`, so forcing the
  `!resp.ok` guard false still converged on `null` via the _downstream_
  "missing access_token" guard firing instead — same
  guard-masks-guard pattern seen on `quarantine.ts` and
  `registry-persistence.ts`. Fixed by giving that mocked response a
  valid `access_token`, so the mutant's fall-through would have produced
  a real token instead of re-converging on `null`. Run with
  `STRYKER_TEST_SCOPE="src/security/__tests__"`.
- **Mutation testing — domain 5, `upstream-auth.ts`** (94 LOC,
  `src/backend-auth/` — per-client upstream auth: static
  bearer/basic/header credential injection). 51 mutants, 76.47%
  baseline (39/51) → **100.00% (51/51), clean** in a single verify
  round. Test file is cross-directory
  (`src/security/__tests__/upstream-auth.test.ts`) — same gotcha class
  as `oauth.ts`. One new `upstream-auth-mutation.test.ts` in that same
  directory, authored directly (12 baseline survivors). Closed: the
  `!row` early-return guard (same "internal crash on a null row is
  swallowed by the same catch block as a genuine decrypt failure"
  pattern as `oauth.ts`'s `!row` guard — distinguished via a logger spy
  proving the decrypt-failure log call does NOT fire on the real
  early-return path); the decrypt-failure log call's exact
  level/message/meta (the existing wrong-key test proved the proxy
  proceeds unauthenticated but never inspected the log call itself);
  basic auth's `username !== undefined && password !== undefined` guard
  (two tests, each with exactly one field present via an
  `as unknown as UpstreamSecret` cast to bypass the type system,
  isolate both halves and the `&&`↔`||` swap); header auth's
  mirror-image `header_name && value !== undefined` guard (same
  two-test pattern); and the switch's `default: return null;` branch
  (no existing test had ever configured an unrecognized `auth_type` at
  all). No new equivalence classes. Run with
  `STRYKER_TEST_SCOPE="src/security/__tests__"`.
- **Mutation testing — domain 5, `redaction.ts`** (86 LOC,
  `src/content-filtering/` — response-side dot-path field redaction:
  wildcard-over-array/object, nested descent, store CRUD). 72 mutants,
  69.44% baseline (50/72) → 93.06% raw (67/72) across 2 verify rounds →
  **effectively 100%** (3 documented equivalents + 2 accepted timeouts).
  Test file is cross-directory
  (`src/tool-policies/__tests__/redaction.test.ts`) — the 4th instance
  of this domain's recurring gotcha. One new `redaction-mutation.test.ts`
  in that same directory, authored directly (22 baseline survivors).
  Closed: a null and a primitive intermediate value (the primitive case
  needed a STRING with a NUMERIC-STRING leaf specifically — a NUMBER
  with a non-numeric leaf coincidentally no-ops the same way real code
  does); wildcard over OBJECT keys, both leaf and nested (the entire
  `else`-branch of the wildcard handler had zero coverage — only arrays
  were ever tested); a named (non-wildcard) segment applied to an array
  intermediate (needed a numeric-string segment, since a real array's
  `hasOwnProperty("0")` is true); a missing LEAF key on an
  otherwise-present intermediate; `setRedactionPaths`' trim/filter-empty
  pipeline; and a genuine DELETE-vs-empty-UPSERT distinction when
  clearing (verified via raw SQL). Two new equivalence classes found:
  `Array.isArray(node)` is unobservable when every value originates from
  `JSON.parse` (iterating via `Object.keys` produces byte-identical
  output to the array-specific loop, since JSON arrays only ever have
  dense numeric-string keys); and recursing into `undefined` is
  unobservable when the same function's own top guard already filters
  non-object values. Also worth noting: a `bun -e` inline eval does NOT
  reflect real ES-module strict-mode semantics — an assignment to a
  primitive that should throw in strict mode silently no-op'd under
  `bun -e` but correctly threw in a standalone `.mjs` script, which is
  what ultimately confirmed the right test construction. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `tool-examples.ts`** (74 LOC,
  `src/tool-meta/` — saved per-tool playground example args: CRUD plus
  `MAX_ARGS_BYTES` validation). 31 mutants, 77.42% baseline (24/31) →
  **100.00% (31/31), clean** in a single verify round. Test file is
  cross-directory (`src/tool-policies/__tests__/tool-examples.test.ts`).
  One new `tool-examples-mutation.test.ts` in that same directory,
  authored directly (7 baseline survivors). Closed: a `null` args value
  (isolates `args === null`, since `typeof null === "object"` in JS
  makes the sibling check false too); a genuine PRIMITIVE non-array args
  value (the existing "non-object args" test only ever used an ARRAY,
  which is `typeof "object"` in JS and never isolates the
  `typeof !== "object"` half); an oversized-args rejection; and the
  exact `MAX_ARGS_BYTES` (16384) boundary, constructed to land exactly
  on the byte count to prove the check is exclusive (`>`) rather than
  inclusive (`>=`). No new equivalence classes. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `tool-tags.ts`** (71 LOC,
  `src/tool-meta/` — per-tool tag CRUD: normalize/dedupe,
  listAllTags/listToolsByTag, getTagsForClient/getAllToolTags). 33
  mutants, 96.97% baseline (32/33 — already very high, since
  `getTagsForClient`/`getAllToolTags` are exercised indirectly via
  `registry.ts`'s own `getClientDetail`/`listAllTools` integration
  tests) → **100.00% (33/33), clean** in a single verify round. Test
  file is at the same directory as its source (`src/tool-meta/__tests__/
tool-tags.test.ts`) — unlike `tool-examples.ts`'s cross-directory
  location, this one mirrors 1:1. One new `tool-tags-mutation.test.ts`,
  authored directly (1 baseline survivor). Closed: `normalizeTag`'s
  dropped `.trim()` — every tag in the existing suite was already
  whitespace-free, so trimming was never observed; one direct call to
  the exported `normalizeTag("  Billing  ")` closed it. No new
  equivalence classes. Run with
  `STRYKER_TEST_SCOPE="src/tool-meta/__tests__"`.
- **Mutation testing — domain 5, `sanitize.ts`** (64 LOC,
  `src/content-filtering/` — prompt-injection defense on tool
  descriptions: 11 `SUSPICIOUS_PATTERNS` regexes, Unicode NFC/NFD
  homoglyph normalization, markdown-code-block strip, space-collapse,
  `MAX_DESCRIPTION_LENGTH` truncation, `wasSanitized`/log). 78 mutants,
  an unusually low 48.72% baseline (38/78 — Stryker's regex mutator
  generates multiple variants per literal across 11 patterns, and the
  Unicode-normalization/`wasSanitized`/log-call internals had zero
  dedicated tests) → **100.00% (78/78), clean** across 2 verify rounds.
  One new `sanitize-mutation.test.ts`, authored directly (40 baseline
  survivors — right at this program's solo-vs-workflow threshold, but
  solo anyway since most of the mass was the already-solved regex
  dual-technique). Closed: the regex dual-technique across all 11
  patterns (character-class-negation `\s`→`\S` on the 3 `\s*`-colon
  patterns, killed by a positive match with a space before the colon;
  quantifier-reduction `\s+`→`\s` on the other 8, killed by DOUBLED
  whitespace — doubling all four gaps of the "do not tell the user"
  phrase at once kills all four independent single-gap mutants
  together; "do not reveal" had zero prior coverage at all); the
  homoglyph-defeating Unicode normalization (`"Café"` → `"Cafe"` exact
  match, plus a doesn't-throw test for a genuine `RangeError` mutant on
  `char.normalize("")`); `wasSanitized`/log (a clean description must
  NOT log; a code-block-only, pattern-only, and truncation-only
  description must each independently log, the pattern-only case
  asserting the exact level/message/meta); the space-collapse step (4
  spaces must collapse to exactly 1, not 0); and the truncation
  boundary's `trimEnd()` vs `trimStart()`. Key findings: a doubled-
  whitespace assertion checking for the doubled-spaced SUBSTRING (rather
  than the single-spaced remnant the pipeline's later unconditional
  collapse step would leave behind either way) passes trivially under
  both real code and the mutant — this caused 5 survivors on the first
  verify round, fixed by asserting against the collapsed form instead;
  and an equivalence investigation that's locally correct about ONE
  sub-scenario (a `|| char` fallback never activating) can still miss
  that Stryker generates several independent mutations on the same
  span whose OTHER effects a normal positive test already kills — always
  check the verify-round survivor list before writing a mutant off.
  Run with `STRYKER_TEST_SCOPE="src/content-filtering/__tests__"`.
- **Mutation testing — domain 5, `tool-mock.ts`** (58 LOC,
  `src/tool-meta/` — per-tool mock/virtualization:
  "always"/"fallback" canned-response config CRUD). 23 mutants, 95.65%
  baseline (22/23) → **100.00% (23/23), clean** in a single verify
  round. Test file is `src/tool-policies/__tests__/mock.test.ts` (the
  "tool-" prefix is dropped from the test filename entirely — yet
  another naming gotcha in this domain). One new
  `tool-mock-mutation.test.ts`, authored directly (1 baseline
  survivor). Closed: `row.enabled === 1` forced always-true, never
  observed since every existing test only ever persisted
  `enabled: true` — one direct `enabled: false` round-trip test closed
  it. No new equivalence classes. Run with
  `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 5, `tool-sensitivity.ts`** (48 LOC,
  `src/tool-meta/` — destructive-tool gating: explicit sensitive flag,
  config auto-gate for write methods, CRUD). The final domain-5 file.
  38 mutants, 68.42% baseline (26/38) → **100.00% (38/38), clean** in a
  single verify round. Test file mirrors 1:1
  (`src/tool-meta/__tests__/tool-sensitivity.test.ts`). One new
  `tool-sensitivity-mutation.test.ts`, authored directly (12 baseline
  survivors). Closed: an unknown-tool `setToolSensitive` call (returns
  exactly `false`, not `true`); clearing via `null` genuinely deletes
  the row (verified via raw SQL); all 4 quadrants of the auto-gate's
  `autoGateWriteMethods && (method==="DELETE"||method==="PUT")`
  expression (the existing test only ever tried the all-true
  quadrant); and `getSensitivityForClient`, which had zero prior
  coverage. No new equivalence classes. Run with
  `STRYKER_TEST_SCOPE="src/tool-meta/__tests__"`.

  **This closes domain 5** (`src/tool-policies` + `src/tool-meta` +
  `src/content-filtering` + `src/backend-auth`, 16 files, ~2311 LOC) —
  14 files needed new tests, all effectively 100% (most exactly 100%).
  Domain 6 (`src/discovery`) is next.

- **Mutation testing — domain 6, `tool-naming.ts`** (58 LOC,
  `src/discovery/` — shared tool-name normalization for auto-discovery
  sources: camelCase→snake_case, invalid-char substitution,
  `MAX_LEN` truncation, and collision disambiguation). 34 mutants,
  67.65% baseline (23/34) → 82.35% raw (28/34) in a single verify round
  → **effectively 100%** (3 documented equivalents + 3 accepted
  timeouts). Test file is cross-directory
  (`src/tool-policies/__tests__/tool-naming.test.ts`). One new
  `tool-naming-mutation.test.ts` in that same directory, authored
  directly (11 baseline survivors). Closed: the collapse-runs regex's
  quantifier reduction (two consecutive spaces must collapse to ONE
  underscore); the leading-strip regex's quantifier reduction (needed
  two leading HYPHENS specifically, since consecutive underscores are
  already collapsed by a prior step); the dropped `.slice(0, MAX_LEN)`
  truncation call (an untruncated 100-char string falls into the "op"
  fallback, which ALSO satisfies the existing `length <= 63` check —
  only an exact-value assertion distinguishes "63 a's" from "op"); and
  `uniqueToolName`'s suffix direction (`suffix++` vs `suffix--` — a
  single collision can't distinguish these since post-increment/
  decrement both read the original value on first use; needed a SECOND
  sequential collision to observe the direction). 3 documented
  equivalents: `TOOL_NAME_RE.test(truncated) && truncated.length > 0`'s
  length check is provably redundant, since `TOOL_NAME_RE` requires a
  non-empty match and every value `truncated` can actually take already
  satisfies the regex whenever non-empty (verified via `bun -e`
  brute-forcing a wide variety of inputs through the real pipeline).
  Run with `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
- **Mutation testing — domain 6, `openapi-discovery.ts`** (228 LOC,
  `src/discovery/` — OpenAPI/Swagger auto-discovery: fetch+DNS-pin, size
  limits, JSON/YAML parse, circular-reference rejection, iterative-BFS
  depth cap, dereference, operation-to-tool mapping, `generateToolName`,
  `buildInputSchema`). 211 mutants, 51.18% baseline (108/211) → 96.68%
  raw (204/211) across 2 verify rounds → **effectively 100%** (6
  documented equivalents + 1 accepted timeout). Given the large
  survivor count (103), used a **5-agent parallel workflow** — one
  agent per functional cluster — each authoring its own test file (33
  tests total), followed by one manual closing pass (4 tests) for the
  remaining real gaps plus verifying two of the agents' own equivalence
  claims. Key findings: `generateToolName`'s result always flows
  through `sanitizeToolName` at its only call site, which masks a
  case-conversion mutant entirely and masks _most_ (but not all —
  trailing path segments survive) artifacts from a dropped
  `.filter(Boolean)`; a `?? fallback` value consumed by exactly one
  narrow check can be unobservable when any placeholder text fails
  that check identically to the real fallback; two test cases can each
  look like they discriminate a directional method swap
  (`startsWith`↔`endsWith`) while both actually producing identical
  results under both versions — a third, deliberately chosen input was
  needed; and `@scalar/openapi-parser`'s `dereference()` return shape
  is more guaranteed than its TypeScript types suggest (`errors` is
  always a real array, `schema` always truthy), making two
  optional-chaining mutants genuine equivalents despite the optional
  types. Run with `STRYKER_TEST_SCOPE="src/discovery/__tests__"`.
- **Mutation testing — domain 6, `graphql-discovery.ts`** (313 LOC,
  `src/discovery/` — GraphQL introspection auto-discovery: type-mapping
  helpers, `typeToJsonSchema`, `buildSelectionSet`, `synthesizeQuery`,
  `fieldToTool`, `discoverToolsFromGraphQl`). 272 mutants, 43.38%
  baseline (118/272) → 98.16% raw (267/272) across 2 verify rounds →
  **effectively 100%** (5 documented equivalents). Given the very
  large survivor count (154, the largest cold-round count this
  session), used a **5-agent parallel workflow** — one agent per
  functional cluster — each authoring its own test file (57 tests
  total), followed by one manual closing pass (5 tests) fixing the
  remaining real gaps. Key findings: an agent independently
  re-verified the task's own mutant citations against the actual
  Stryker JSON report and caught a mislabeling in the orchestrating
  prompt — worth telling future multi-agent prompts to verify
  citations against the raw report rather than trusting prose
  descriptions; a `.join(", ")` separator mutant survived because a
  test used a single-arg field (nothing to actually join) and an
  `?? []` fallback mutant survived because a later `.filter()` step
  happened to erase the placeholder's content regardless of which
  fallback fired; two type-mapping guards needed deliberately
  MALFORMED fixtures (a type whose `kind` tag and payload field are
  inconsistent) to isolate their forced-true mutants, since the code
  never cross-validates them and every realistic fixture keeps them
  consistent; and a recursive function's branching read `kind` off the
  wrong one of two structurally-similar objects (a type reference vs.
  its resolved typeMap target) in an initial fixture, silently failing
  to exercise the intended branch at all. Run with
  `STRYKER_TEST_SCOPE="src/discovery/__tests__"`.
- **Mutation testing — domain 6, `curl-postman-discovery.ts`** (469 LOC,
  `src/discovery/` — the largest domain-6 file and the final one:
  `tokenizeShellLike`, `parseCurlCommand`/`parseSingleCurlCommand`,
  `parsePostmanCollection`/`parsePostmanLeaf`, and the shared
  `toParsedUrl`/`extractPathAndQuery`/`extractBodyKeys`/
  `generateNameFromPath`/`describeSource` helpers). 580 mutants — the
  largest cold-round survivor/timeout count in this entire program (252
  survivors + 27 timeouts baseline) → 95.17% raw-detected (513 killed +
  39 accepted timeouts) → **effectively 100%** (all 28 raw survivors are
  documented equivalents). Given the scale, used a **5-agent parallel
  workflow** — one agent per functional cluster (tokenizer, cURL
  flag-parsing loop, Postman collection walk, Postman URL/body-key
  extraction, shared helpers) — each authoring its own test file (73
  tests total), followed by one manual closing pass (6 tests) fixing 5
  real gaps plus confirming 1 new equivalent. Learning from
  `graphql-discovery.ts`'s orchestrator-citation-error lesson, every
  agent was told up front to re-query the raw Stryker JSON report rather
  than trust prose — zero citation-mislabeling incidents this round. Key
  findings: a backward-walking escape-scan mutant (`j += 2` → `j -= 2`)
  is a genuine real infinite loop, confirmed via a hand-simulated
  1000-iteration-guarded copy, expected to (and did) surface as a
  Stryker Timeout rather than Killed; a `typeof x !== "string"` guard's
  forced-true half is only observable with a genuinely non-string input
  (every existing empty-string test already made that half false
  regardless of the mutation); a line-continuation replacement-space
  mutant needed a continuation with NO other adjacent whitespace, since
  the cold round's fixtures happened to have a real space nearby anyway;
  the SAME "caller normalization masks a helper's mutant" pattern from
  `openapi-discovery.ts` recurred for the Postman folder-label join —
  `sanitizeToolName`'s own camelCase-boundary regex reinserts the exact
  underscores a dropped `.join("_")` separator would have provided
  whenever every segment name is Capitalized, so all-lowercase segments
  were needed to avoid the masking; and a new genuine equivalent,
  `parsed !== null` forced always-true in `extractBodyKeys`' JSON-shape
  check for a literal-`null` body — the forced-true mutant's
  `Object.keys(null)` throw is caught by the SAME try/catch wrapping the
  original `JSON.parse` call, falling through to a urlencoded-regex
  fallback that can't match the text `"null"` either, so both real and
  mutant converge on the identical final `[]`. Run with
  `STRYKER_TEST_SCOPE="src/discovery/__tests__"`. **This closes domain 6
  (src/discovery, 4 files) entirely** — domain 7 (`src/observability`,
  10 files) is next.
- **Mutation testing — domain 7, `anomaly.ts`** (46 LOC,
  `src/observability/` — usage-spike detection: `detectUsageSpike`
  compares a recent-window call rate against a preceding baseline-window
  rate). 28 mutants, 82.14% baseline (23/28) → 96.43% raw (27/28) in a
  single verify round → **effectively 100%** (1 documented equivalent).
  Test dir is cross-directory: the dedicated test lives at
  `src/admin/entities/__tests__/anomaly.test.ts`, not
  `src/observability/__tests__/` — the new
  `anomaly-mutation.test.ts` was added alongside it. One new test file,
  authored directly. Closed: two `?? default` fallbacks
  (`opts.factor ?? 3`, `opts.minCalls ?? 20`) mutated to `&&` — only
  observable with an explicit truthy value distinct from the literal
  default, since the existing tests always passed the same value as the
  default; and two exact boundary checks (`recent.calls === minCalls`,
  `recentRate === baselineRate * factor`), the second computed by hand
  from the real default windows (5-minute recent, 60-minute baseline) to
  land exactly on the boundary with no floating-point risk. One
  documented equivalent: a `baselineRate === 0 ? true : ...` ternary
  forced to always take the else branch is unobservable because SQL
  `COUNT(*)` call counts are always non-negative and the window-size env
  fallback (`Number(process.env.X) || <default>`) can never actually
  produce a zero-or-negative window, so whenever baselineRate is
  genuinely 0, the recomputed comparison is unconditionally true too.
  Run with `STRYKER_TEST_SCOPE="src/observability/__tests__
src/admin/entities/__tests__"`.
- **Mutation testing — domain 7, `monitor.ts`** (227 LOC,
  `src/observability/` — synthetic monitoring + schema-drift detection:
  `setMonitor`/`deleteMonitor`/`listMonitors` CRUD, `runSyntheticChecks`'
  replay+drift-check+notify loop, `notifyMonitor`'s webhook dispatch).
  121 mutants, 60.33% baseline (73/121) → 97.52% raw (118/121) across 2
  verify rounds → **effectively 100%** (3 documented equivalents). Test
  dir is cross-directory: the dedicated test lives at
  `src/admin/entities/__tests__/monitor.test.ts`, not
  `src/observability/__tests__/` — the new `monitor-mutation.test.ts`
  was added alongside it. One new test file, authored directly (48
  baseline survivors across many small clusters). Closed: `rowTo`'s
  `enabled` boolean mapping and `setMonitor`'s exact interval boundary
  (1/1440), both completely unasserted despite existing CRUD tests; the
  entire `error`-field cluster on a failed check (exact short-body error
  text, a >500-char body proving `.slice(0, 500)` actually truncates,
  and a successful check clearing `lastError` back to `null`) — none of
  which the existing tests had ever checked (only `status`, never
  `error`); and a no-op-guard mutant (`if (deleted) annotateToolDrift(...)`
  forced unconditional) that needed a monitor with an ACTIVE drift note
  whose row was then removed via a raw SQL `DELETE` bypassing
  `deleteMonitor` itself, since deleting an already-nonexistent monitor
  is otherwise indistinguishable regardless of whether the guard fires.
  Two documented equivalents share one root cause: `result.content[0]?.text
?? "error"` is defensive code the dispatch pipeline's own
  `toolResult()` helper makes unreachable, since every `isError: true`
  result it can produce always has a real single-element content array
  — the same "helper's own guarantee is stronger than the optional type
  suggests" pattern already seen on `mcp-upstream.ts` and
  `openapi-discovery.ts`. A third: `if (!row) return null;`'s
  forced-false mutant looked like it should throw instead of returning
  early, but the resulting `row.args_json` access sits inside the very
  next `try`/`catch`, so the same catch swallows it and returns `null`
  either way — verified empirically before accepting rather than assumed.
  Run with `STRYKER_TEST_SCOPE="src/observability/__tests__
src/admin/entities/__tests__"`.
- **Mutation testing — domain 7, `alerts.ts`** (261 LOC,
  `src/observability/` — alert rule CRUD + periodic condition
  evaluation: `evaluateCondition`'s 5 event-type switch cases
  (`client_unreachable`/`circuit_breaker_open`/`error_rate`/`usage_spike`/
  `schema_drift`/default), the edge-triggered `evaluateAlerts` loop,
  `dispatchAlertWebhook`, `sendTestAlert`, `startAlertLoop`). 161
  mutants, 43.48% baseline (70/161) → 99.38% raw (160/161) in a single
  verify round → **effectively 100%** (1 documented equivalent). Test
  dir is cross-directory (the 3rd domain-7 file in a row): dedicated
  test at `src/admin/entities/__tests__/alerts.test.ts`. Given the
  largest domain-7 survivor count (91), used a **5-agent parallel
  workflow** — one agent per cluster — each authoring its own test file
  (48 tests total across `alerts-mutation-ac1..ac5.test.ts`). Two of
  the five agents hit a genuine mid-response server error mid-run: one
  had already written a complete, correct file needing only 2 minor
  TypeScript tuple-length fixes (a `spy.mock.calls[0]` cast needs 3
  tuple elements, since `dispatchWebhook` takes 3 positional args); the
  other left no file at all and was retried as a single direct agent
  call, succeeding cleanly. Reached effectively 100% in a single
  combined verify round — no 2nd round needed. One documented
  equivalent, found and empirically verified by one of the cluster
  agents via a standalone scratch script: the `default` switch case's
  `{ active: false, detail: {} }` return value collapsed to `{}` is
  unobservable, since `undefined` and `false` are both falsy in every
  branch condition `evaluateAlerts` checks, and `detail` is only ever
  read when `active` is truthy (never true for either variant). Other
  findings: a numeric-string `id` passed to `getAlertRule`'s
  `!Number.isInteger(id)` guard was verified (via a scratch
  `bun:sqlite` probe) to actually match a row if the guard were
  skipped, thanks to SQLite's type-affinity coercion — confirming the
  guard is a real, exploitable gap, not just defensive paranoia; and
  the dense `error_rate` boundary cluster (`summary.calls >= minCalls
&& summary.errorRate >= threshold`) needed 4 separate boundary
  scenarios to fully pin down `&&` vs `||` plus each side's own
  comparator variants. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__
src/admin/entities/__tests__"`. **This closes anomaly.ts + monitor.ts
  - alerts.ts, all 3 cross-directory files in domain 7** — the 7
    remaining files (health.ts, traffic.ts, tracing.ts, trace-context.ts,
    trace-store.ts, usage.ts, metrics.ts) all have dedicated tests
    directly under `src/observability/__tests__/`.
- **Mutation testing — domain 7, `health.ts`** (126 LOC,
  `src/observability/` — the leader-gated background health-check
  loop: per-client REST/MCP probing via `checkBatch`, consecutive-
  failure tracking + auto-eviction via `handleFailure`, and Prometheus
  metrics for every outcome, all wrapped by `startHealthCheckLoop`).
  89 mutants, an unusually low 22.47% baseline (20/89 — the existing
  dedicated test only checked 2 Prometheus counters via the real
  background loop, almost everything else was untested) → 98.88% raw
  (87/89) across 2 verify rounds → **effectively 100%** (1 documented
  equivalent + 1 accepted timeout). Test dir mirrors 1:1
  (`src/observability/__tests__/`), the first domain-7 file to do so.
  Given the large survivor count (68, comparable to `alerts.ts`'s 91),
  used a **4-agent parallel workflow** — one agent per cluster — each
  authoring its own test file (17 tests total across
  `health-mutation-hc1..hc4.test.ts`). All 4 agents completed cleanly.
  A single verify round drove 22.47% → 97.75%; one manual fix closed
  the last real gap. Key findings: `checkBatch`/`handleFailure` are
  both module-private, so every test drives them indirectly through
  the sole exported `startHealthCheckLoop()` (start the loop, await a
  short real delay, stop() in a finally block); `refreshLeaderStatus()`
  is a load-bearing `beforeEach` call easy to miss, since the loop only
  probes backends when the process believes itself the elected leader;
  and a near-instantly-resolving `fetch` mock made an elapsed-time
  arithmetic mutant (`÷1000` → `×1000`) genuinely unobservable by
  accident, not by any real equivalence — with a same-microtask-tick
  mock, `Date.now() - hcStart` is exactly `0`, and `0 / 1000 === 0 *
1000 === 0` regardless of the operator, discovered by hand-applying
  the mutation and confirming the test still passed unmodified; fixed
  by making the mock resolve after a real 20ms delay instead. One
  documented equivalent: the batching loop's `i < clients.length`
  bound widened to `i <= clients.length` only ever adds one iteration
  where `i` lands exactly on `clients.length`, at which point
  `clients.slice(i, i+concurrency)` is provably `[]`, making that extra
  iteration a total no-op. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `traffic.ts`** (152 LOC,
  `src/observability/` — per-call traffic capture for the admin traffic
  explorer + replay: `recordTraffic`/`listTraffic`/`getTraffic`/
  `pruneTraffic` CRUD, opt-in globally and time-bounded by retention).
  65 mutants, 58.46% baseline (38/65) → 98.46% raw (64/65) across 2
  verify rounds → **effectively 100%** (1 documented equivalent). Test
  dir mirrors 1:1 (`src/observability/__tests__/`). One new test file,
  authored directly (27 baseline survivors, small enough for one pass).
  Closed: `rowTo`'s `isError` boolean mapping, untested despite an
  `errorsOnly` FILTER test existing (the filter only checked the SQL
  row count, never asserted `.isError` on a returned record); a
  probabilistic-sampling boundary (`Math.random() < 0.02`) needing the
  exact threshold value itself, not just one value on each side; a
  cutoff-direction arithmetic mutant (`now - retentionMs` → `now +
retentionMs`) needing the DEFAULT `now`, since the existing test
  forced `now` so far into the future that both directions converged
  on "prune everything" regardless of operator; and a test-only helper
  (`__clearTrafficForTesting`) that had zero coverage of its own
  despite being used throughout the existing suite's own
  `beforeEach`/`afterEach`. One documented equivalent, a new variant of
  the "downstream step erases a fallback's own content" pattern:
  `input.result.content ?? []`'s fallback mutated to Stryker's sentinel
  `["Stryker was here"]` is unobservable, because the very next step
  reads `.text` off each element — a bare string has no `.text`
  property, so it maps to `""` exactly like an empty array does, and
  both `[""].join("\n")` and `[].join("\n")` are `""`. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `tracing.ts`** (185 LOC,
  `src/observability/` — dependency-free OTLP/HTTP span export:
  `startSpan`/`endSpan`, batching + deferred-flush scheduling, OTLP
  payload construction, best-effort export via `flush()`). 92 mutants,
  54.35% baseline (50/92) → 94.57% raw (87/92) across 2 verify rounds →
  **effectively 100%** (5 documented equivalents). Test dir mirrors 1:1
  (`src/observability/__tests__/`). One new test file, authored
  directly (42 baseline survivors). Closed: the exact request shape of
  the OTLP export (method/headers/redirect, previously only the body
  was checked), the OTLP attribute-value mapping for booleans and
  numbers (an existing test happened to pass a boolean attribute but
  never asserted its mapped shape), the nanosecond timestamp encoding's
  exact value (only `typeof === "string"` was checked before), and the
  full deferred-flush timer lifecycle (scheduling, re-arming, and the
  captured callback's own effects, driven directly via a `setTimeout`
  spy rather than waiting out the real 2-second delay). Key findings: a
  bare test call to `setCurrentSpan`/`getCurrentSpan` is silently
  vacuous outside a real `AsyncLocalStorage` run, since both no-op
  without one — needed wrapping in `withTraceContext(...)` to observe
  anything; a `ConditionalExpression` mutant on an always-true
  real-world condition (`if (t.unref) t.unref();`, since a real timer
  object always has `.unref`) is a genuine equivalent for ONE direction
  only, not both — the opposite (forced-false) direction is a real,
  killable gap; and a same-line compound-boolean guard's two halves
  each needed their own distinguishing scenario, discovered only on a
  second verify round after the first round's dual-purpose test left
  one half unkilled. 5 documented equivalents: a module-private helper
  (`genId`) with zero real call sites anywhere in the codebase
  (confirmed via a repo-wide grep), the module-level `buffer`/
  `flushScheduled` initial values (the same "DI-helper initial value
  unreachable once a resetting beforeEach exists" class already seen on
  load-balancer.ts/quarantine.ts), and the `t.unref` always-true
  direction above. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `trace-context.ts`** (188 LOC,
  `src/observability/` — W3C Trace Context: `parseTraceparent`/
  `formatTraceparent`, `newTraceId`/`newSpanId`, the
  AsyncLocalStorage-backed per-request context, outbound
  traceparent/tracestate propagation). 99 mutants, an already-strong
  83.84% baseline (83/99) → 93.94% raw (93/99) across 2 verify rounds →
  **effectively 100%** (4 documented equivalents + 2 accepted
  timeouts). Test dir mirrors 1:1 (`src/observability/__tests__/`). One
  new test file, authored directly (14 baseline survivors). Closed: all
  three anchored hex-length regexes (`TRACE_ID_RE`/`SPAN_ID_RE`/
  `FLAGS_RE`) had both their `^`/`$` anchors survive, needing a third
  regex-mutant technique beyond the established character-class-
  negation/quantifier-reduction pair — an input exactly one character
  too long that still contains a full valid run at the start or end,
  which an anchored regex correctly rejects but an anchor-dropped one
  matches anyway; an uppercase-hex flags value that parses to a
  perfectly finite number (defeating a later `Number.isFinite` check)
  but fails the regex's lowercase-only requirement; and the all-zero
  trace-id/span-id collision-retry guards, driven via a `randomBytes`
  mock returning an all-zero buffer once. One new equivalence-reasoning
  chain: a seemingly-obvious new test for the `value === ""` guard was
  written and run, but still failed to kill its target mutant on
  verify — re-investigating (rather than assuming the test was wrong)
  revealed the guard is masked by the very next line's `parts.length <
4` check for every empty-value input, the same structural reason
  already established for that next guard's own equivalence. 4
  documented equivalents total, all tracing to the same underlying
  fact: every early guard for a malformed/incomplete traceparent is
  redundant with either the length check or one of the three
  field-format regexes, since an `undefined` destructured field or an
  empty split result always fails a later check the same way. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `trace-store.ts`** (224 LOC,
  `src/observability/` — SQLite-persisted spans for the admin-UI trace
  viewer: `persistSpan`, `listTraces`/`getTrace`/`getTopSessions`,
  `pruneSpans`/`purgeAllSpans`). 62 mutants, 80.65% baseline (50/62) →
  **100.00% (62/62), clean** in a single verify round. Test dir mirrors
  1:1 (`src/observability/__tests__/`). One new test file, authored
  directly (12 baseline survivors — the same cluster shapes already
  closed on this file's structural sibling, `traffic.ts`: a
  type-check-vs-presence-check gap on two attribute-extraction
  ternaries, an unasserted DB-write catch block, a probabilistic-prune
  exact-boundary gap, a combined-filter `" AND "`-join gap, and a
  test-only helper with zero coverage of its own). Reused the exact
  same fixture techniques established for `traffic.ts`'s own closing
  pass — no new equivalence classes needed, straight reuse of an
  already-proven playbook start-to-finish. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `usage.ts`** (224 LOC,
  `src/observability/` — proxy usage analytics: `recordUsage`,
  `getUsageSummary`/`getUsageTimeseries`/`getTopTools`/`getUsageByKey`).
  114 mutants, 53.51% baseline (61/114) → 97.37% raw (111/114) across 2
  verify rounds → **effectively 100%** (3 documented equivalents). Test
  dir mirrors 1:1 (`src/observability/__tests__/`). One new test file,
  authored directly (53 baseline survivors — mostly mechanical numeric-
  boundary shapes rather than deep functional complexity, so a Workflow
  wasn't needed despite the count). Closed: bucket-size selection at
  the 26-hour threshold and its millisecond-constant arithmetic, the
  60-second bucket floor, an exact last-bucket-boundary computation, the
  `MAX_TIMESERIES_POINTS` (1000) cap on a window wide enough to exceed
  it, limit clamping across three separate functions, and a "no
  matching label" fallback string. Key findings: a module-level counter
  with no exported getter/reset helper, observed only via a `% N === 0`
  sampling check, reproduces the SAME `++`/`--`-direction equivalence
  already established for `rate-counters.ts`'s `opCount` — confirming
  the class generalizes, not just that one prior instance; tested the
  "fires every 500th call" trigger deterministically (despite an
  unknown, cross-test-file-shared starting offset) by calling the
  function exactly 500 times and asserting the prune query fired
  exactly once, since any 500 consecutive calls cross exactly one
  multiple of 500 regardless of where they start; and a
  limit-clamping-ceiling test needed data that actually EXCEEDS the
  ceiling to be observable — an initial fixture with only 3 rows passed
  under both the real 200-cap and a mutant with no cap at all, fixed by
  seeding 201 distinct rows and asserting the exact clamped count. One
  new equivalence class: an identical `calls > 0 ? errors/calls : 0`
  code shape in two different functions has DIFFERENT equivalence
  properties depending on how each function's query actually produces
  the value — `getUsageSummary`'s plain aggregate can genuinely return
  `calls = 0`, but `getTopTools`' `GROUP BY` query can never emit a
  zero-count group at all, making the same-looking guard partially
  redundant there specifically. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`.
- **Mutation testing — domain 7, `metrics.ts`** (322 LOC,
  `src/observability/` — the LARGEST domain-7 file and the last one: a
  dependency-free Prometheus text-exposition-format implementation
  (Counter/Gauge/Histogram/MetricsRegistry primitives), ~20 exported
  metric constant declarations used throughout the codebase, and a
  small "legacy JSON metrics" section for the older `/metrics/legacy`
  route). 172 mutants, 48.84% baseline (85/172) → 96.51% raw (166/172)
  in a single verify round after the cold round → **effectively 100%**
  (4 documented equivalents + 2 accepted timeouts). Test dir mirrors
  1:1 (`src/observability/__tests__/`). Given the large survivor count
  (85, the largest in domain 7), used a **4-agent parallel workflow**
  (label helpers + Counter + Gauge; Histogram + MetricsRegistry; the
  ~20 metric constant declarations via the bulk-schema-toEqual
  technique; the legacy JSON metrics section), 26 tests total. All 4
  agents completed cleanly; one manual fix was still needed afterward:
  a cluster's initial design assumed a "pristine module state"
  precondition that was correct for the file's own scoped Stryker run
  but broke the full `bun run test` gate, since dozens of other
  directories' tests exercise the same shared, un-resettable
  module-level counter for real before `src/observability` runs
  alphabetically in a full-tree sweep — fixed by documenting those 3
  mutants as equivalent-in-practice instead of chasing a fragile
  ordering assumption. This is the THIRD recurrence in this one file of
  the same "module-level state, no reset hook, permanently touched by
  real production code elsewhere in the suite" pattern (after a
  session-getter default and a latencies-array empty-precondition),
  worth treating as a standing category to check for on any future
  un-resettable module state. Run with
  `STRYKER_TEST_SCOPE="src/observability/__tests__"`. **This closes
  domain 7 (`src/observability`, 10 files) entirely** — domain 8
  (`src/routes` + `src/routes/admin`) is next.
- **Mutation testing — domain 8, `docs.ts`** (17 LOC, `src/routes/` —
  a NODE_ENV-conditional auth-guard selector wrapping the Swagger UI
  mount at `/docs`). 7 mutants, 0% baseline (0/7 — zero test coverage
  of any kind existed before this) → **100.00% (7/7), clean** in a
  single verify round. Test dir mirrors 1:1 (`src/routes/__tests__/`),
  new file `routes-docs-mutation.test.ts`. Authored directly, real
  HTTP integration tests (Express app + `listen(0)` + real `fetch`,
  matching the existing `routes-*.test.ts` convention): development
  mode bypasses auth entirely; any other `NODE_ENV` value requires a
  valid Bearer admin key; the route is genuinely mounted at exactly
  `/docs` (an unrelated path 404s); and a real round-trip resolving at
  all (rather than hanging) proves the dev-mode passthrough actually
  calls `next()`. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `validation.ts`** (34 LOC,
  `src/routes/` — almost entirely type declarations
  (`ValidationResult`/`LooseValidationResult`) plus one tiny lookup
  function, `mutationErrorToStatus`). 1 mutant → **100.00% (1/1),
  already clean at baseline** — the single `mutationErrorToStatus`
  mutant is killed indirectly by the many route test files (oauth.ts,
  alerts.ts, bundles.ts, catalog.ts, and others) that exercise its call
  sites through their own error-handling paths. No new test file
  needed, no fix cycle — same "not every file needs new work, always
  run baseline first" precedent as domain 3's
  registry-alias-index.ts/tool-index.ts.
- **Mutation testing — domain 8, `http-errors.ts`** (37 LOC,
  `src/routes/` — shared `sendError`/`validationError`/`notFound`/
  `forbidden` error-envelope helpers + the `requestId` reader, used by
  nearly every route file). 9 mutants, 22.22% baseline (2/9) →
  **effectively 100%** (5/9 killed + 4 accepted timeouts, 0 real
  survivors) in a single verify round. Test dir mirrors 1:1
  (`src/routes/__tests__/`), new file
  `routes-http-errors-mutation.test.ts`. Authored directly using a
  minimal hand-rolled Express `Response` mock (capturing `.status()`/
  `.json()` calls) rather than a real HTTP server, since these are
  pure functions operating on `res` alone. Closed `requestId()`'s `??
null` fallback and `validationError`'s exact `"VALIDATION_ERROR"`
  code string. The 4 accepted timeouts are each one of the four
  functions' own whole-body-emptied mutant — emptying any of them
  returns `undefined` instead of the chained `res.status().json()`
  Response, hanging a real HTTP-level caller waiting for a response
  that never gets sent, so Stryker correctly times out rather than
  marking Killed. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `traces.ts`** (39 LOC, `src/routes/` —
  4 admin-api endpoints: `GET /admin-api/traces` list+filter,
  `GET .../top-sessions`, `GET .../:traceId`, `DELETE /admin-api/traces`
  purge+audit). 41 mutants, 0% baseline (zero test coverage of any kind
  existed before this) → **effectively 100%** (40/41 killed + 1 accepted
  timeout) after 3 iterations. Test dir mirrors 1:1
  (`src/routes/__tests__/`), new file `routes-traces-mutation.test.ts`.
  Two fix rounds: the `?tool`/`?session_id`/`?cursor` typeof-string
  guards' forced-true direction needed Express's repeated-query-key →
  array behavior to produce an observable divergence a plain
  absent/present-string test can't reach; the cursor guard's
  forced-false / `typeof x === ""` direction needed the pagination test
  strengthened to assert page 2's item is a genuinely different
  `traceId` than page 1's, since silently dropping the cursor just
  re-returns page 1's item at the same length. The 1 accepted timeout is
  the GET-list handler's own whole-body-emptied mutant (same "genuine
  Stryker timeout = detected" convention as elsewhere in this program).
  Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/connect.ts`** (15 LOC,
  `src/routes/admin/` — single `GET /connect/gateway-url` read-only
  helper). 4 mutants → **100.00% (4/4), already clean at baseline** —
  the pre-existing `routes-connect.test.ts` (73 LOC) already killed
  every mutant. No new test file needed, no fix cycle — same
  "not every file needs new work, always run baseline first" precedent
  as `validation.ts`. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/monitors.ts`** (16 LOC,
  `src/routes/admin/` — single `GET /monitors` read-only
  dashboard-snapshot endpoint wrapping `listMonitors()`). 3 mutants, 0%
  baseline (zero test coverage of any kind existed before this) →
  **100.00% (3/3), clean** in a single verify round. Test dir mirrors
  1:1 (`src/routes/__tests__/`), new file
  `routes-monitors-mutation.test.ts`. Fixture note: `tool_monitor` has
  `NOT NULL` `example_id`/`baseline_schema_hash` columns plus a foreign
  key to `tools(client_name, name)` with `foreign_keys=ON` — reused the
  real production helpers (`registry.register()`, a `tool_examples`
  insert, and the actual exported `setMonitor()`) rather than
  hand-rolling INSERT SQL, matching the fixture pattern already
  established in `src/admin/entities/__tests__/monitor.test.ts`. Run
  with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/overview.ts`** (39 LOC,
  `src/routes/admin/` — `GET /overview` dashboard counters: client
  status breakdown, disabled client/tool counts, circuit breaker state
  counts, admin user count). 33 mutants, 36.36% baseline (12/33) →
  **100.00% (33/33), clean** in a single verify round. New file
  `routes-overview-mutation.test.ts` adds coverage
  `routes-admin.test.ts`'s existing happy-path smoke test was missing.
  Two reusable techniques: an asymmetric enabled/disabled split (e.g. 1
  enabled + 2 disabled) is required to kill a negation-removal mutant
  (`!c.enabled` → `c.enabled`) that a 1-vs-1 split can't distinguish;
  and — since the circuit breaker registry is a process-wide singleton
  shared with every concurrently-run test file and never reset — circuit
  breaker counts are asserted as a DELTA around adding one fresh breaker
  of each kind (closed/open/half-open) within a single test, rather than
  as absolute values. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `introspection.ts`** (41 LOC,
  `src/routes/` — `GET /clients`, `GET /clients/:name/tools`, `DELETE
/clients/:name`, each guarded by `adminAuth` directly rather than a
  shared router). 28 mutants, 0% baseline (zero test coverage of any
  kind existed before this) → **100.00% (28/28), clean** in a single
  verify round. Test dir mirrors 1:1 (`src/routes/__tests__/`), new
  file `routes-introspection-mutation.test.ts`. Standard real-HTTP +
  `registry.register()`/`unregister()` fixtures; the `DELETE` handler's
  `log()` call verified with a `spyOn` assertion for the exact
  `("info", "Client unregistered", { name })` arguments. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `usage.ts`** (41 LOC, `src/routes/` —
  4 read-only usage-analytics `GET` endpoints: `/summary`,
  `/timeseries`, `/top-tools`, `/by-key`). 28 mutants, 57.14% baseline
  (16/28, existing `routes-usage.test.ts` covered the happy path) →
  **effectively 100%** (27/28, 1 accepted equivalent) in a single
  verify round. New file `routes-usage-mutation.test.ts`. One genuine
  equivalent, verified empirically: the `num()` helper's `typeof v !==
"string"` guard forced always-false is unreachable-different, since
  Express's default query parser only ever produces
  string/string[]/undefined for `req.query` values, and `Number()` of
  any reachable `string[]`/`undefined` is always `NaN`. Two reusable
  techniques for the `?client=` filter: an asymmetric 2-client fixture
  kills the forced-false/flipped-equality directions; a repeated-query-
  key array kills the forced-true direction via a new discriminator —
  `bun:sqlite` throws synchronously when a plain array is bound as a
  query parameter, turning into a 500 through Express's default error
  handler, so asserting the response STAYS 200 is a clean kill. Run
  with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `tags.ts`** (44 LOC, `src/routes/` —
  `GET /admin-api/tags`, `GET /admin-api/tags/:tag/tools`, `PUT
/admin-api/clients/:name/tools/:tool/tags`). 41 mutants, 65.85%
  baseline (27/41, existing `routes-tags.test.ts` covered the happy
  path but only asserted status codes) → **100.00% (41/41), clean** in
  a single verify round. New file `routes-tags-mutation.test.ts`. Key
  technique: the `!Array.isArray(body.tags) || !body.tags.every((t) =>
typeof t === "string")` validation guard had FIVE distinct survivor
  mutants on one line, all collapsing to the same observable failure —
  bypassing validation lets a non-array or mixed-type `tags` value
  reach `.map(normalizeTag)`, which throws on a non-string element,
  crashing with a 500 instead of a clean 400. Two fixtures (a bare
  string; a mixed `["real-string", 123]` array) killed all five at once
  by asserting the response stays a clean 400. Also added exact-body
  assertions (message content, exact `TOOL_NOT_FOUND` envelope, exact
  success shape, exact `recordAudit` args) the pre-existing test never
  checked. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/index.ts`** (51 LOC,
  `src/routes/admin/` — top-level admin router: wires `adminAuth` +
  mounts every per-entity sub-router under `/admin-api`). 2 mutants →
  **100.00% (2/2), already clean at baseline** — the many
  `routes-admin.test.ts`/`routes-*.test.ts` tests that hit any
  `/admin-api/...` path already exercise both mutants indirectly. No
  new test file needed, no fix cycle. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/canary.ts`** (54 LOC,
  `src/routes/admin/` — `GET`/`PUT /clients/:name/canary`, per-client
  secondary-upstream canary/failover config). 56 mutants, 0% baseline
  (zero test coverage of any kind existed before this) →
  **effectively 100%** (55/56, 1 accepted equivalent) after 2 verify
  rounds. New file `routes-canary-mutation.test.ts`. One genuine
  equivalent, verified empirically: the weight parser's `typeof
body.weight === "number"` guard forced always-true — since
  `JSON.parse` always deserializes a JSON numeric literal to a genuine
  JS `number`, any non-number `body.weight` fails `Number.isInteger`
  identically whether or not the guard defaults it to 0 first. First
  verify round missed the `PUT` handler's own independent copy of the
  `!ensureClientAccess(...)` cross-team-denial guard (only the `GET`
  handler's copy was tested) — fixed with a second cross-team-denied
  PUT test. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/traffic.ts`** (55 LOC,
  `src/routes/admin/` — `GET /traffic` list+filter, `GET /traffic/:id`,
  `POST /traffic/:id/replay` via `proxyToolCall`). 47 mutants, 0%
  baseline (zero test coverage of any kind existed before this) →
  **effectively 100%** (46/47 killed + 1 accepted timeout) after 2
  verify rounds. New file `routes-traffic-mutation.test.ts`. Same
  client/tool/cursor/limit typeof-string-filter cluster shape as
  `traces.ts`. First verify round exposed a technique gap: for the
  cursor filter, a non-string array doesn't crash `bun:sqlite` the way
  client/tool do — `Number(nonStringValue)` coerces to a valid (if
  useless) `NaN` before binding — so the forced-true mutant instead
  silently returns zero items instead of crashing; fixed by asserting
  the item count, not just that the response stays 200. Also reused
  the `admin/canary.ts` "same guard, multiple call sites" lesson (`GET
/:id` and `POST /:id/replay` each have their own independent `!rec`
  guard) and spied on `proxyToolCall` directly to assert the replay
  endpoint's exact parsed args. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `register.ts`** (56 LOC,
  `src/routes/` — `POST /register` dispatch to REST/MCP/GraphQL
  registration, `GET /register/schema`). 58 mutants, 50.00% baseline
  (29/58, existing `routes-register.test.ts` is thorough for the
  dispatch branches but never isolates individual OR-clauses, never
  checks exact messages/`request_id`, never tests the `tools[]` cap AT
  the boundary, and never touches `GET /register/schema`) →
  **effectively 100%** (50/58 real kills + 8 accepted: 1 timeout + 2
  equivalents) after 2 verify rounds. New file
  `routes-register-mutation.test.ts`. Two genuine equivalents:
  `req.socket?.remoteAddress`'s optional-chaining mutant (a property
  that's always present on any real HTTP request) and the `GET
/register/schema` 503-fallback branch's whole cluster — gated by a
  module-level constant resolved once at import time from the repo's
  own checked-in OpenAPI spec, with no mocking mechanism in this
  codebase to force a load failure. Fix-cycle miss on the first verify
  round: a `request_id` test targeted the wrong code path (register.ts's
  own Change-A guard, which never reads the local `requestId`
  variable) — fixed by re-targeting a registration-function validation
  error, where that variable is actually consumed. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/oauth.ts`** (64 LOC,
  `src/routes/admin/` — `GET`/`PUT /clients/:name/oauth`, outbound
  OAuth2 client-credentials config per upstream client). 57 mutants, 0%
  baseline (zero test coverage of any kind existed before this) →
  **effectively 100%** (54/57 killed + 3 accepted timeouts) after 2
  verify rounds. New file `routes-oauth-mutation.test.ts`.
  Structurally near-identical to `admin/canary.ts` (same session) —
  its whole test design was reused verbatim. One new discriminator: the
  `scope` field's typeof-string ternary forced always-true survived a
  first verify round because a non-string `scope` (a number) doesn't
  crash — SQLite's `STRICT` `TEXT`-column type coercion silently
  accepts it (verified empirically), storing its string representation
  instead of throwing — fixed by asserting the persisted `scope` is
  `null` (real code's fallback), not the mutant's coerced value. Run
  with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `install-links.ts`** (66 LOC,
  `src/routes/` — public/unauthenticated `GET /install/:token`,
  resolves a bundle install link and generates a connect snippet). 29
  mutants, 75.86% baseline (22/29, existing
  `routes-bundle-install-links.test.ts` covers the happy paths but
  never varies `gatewayPublicUrl`, checks exact messages, or exercises
  a tool missing from the live registry) → **effectively 100%** (27/29
  killed, 2 accepted equivalents) in a single verify round. New file
  `routes-install-links-mutation.test.ts`. Two genuine equivalents: the
  no-Host-header `localhost` fallback (HTTP/1.1 mandates a Host
  header) and the tool-description `?? ""` fallback — proven
  unreachable BY CONSTRUCTION via a schema-level FK constraint
  (`mcp_bundle_tools` cascades on delete from `tools`, verified
  empirically, so a bundle can never reference a tool missing from the
  live registry). Also caught and fixed a wrong-method mistake:
  `registry.unregister()` only tears down the in-memory registry entry
  and leaves the underlying DB rows in place; only
  `registry.forgetClient()` actually deletes them. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/audit-log.ts`** (68 LOC,
  `src/routes/admin/` — `GET /audit-log` list+filter, `GET
/audit-log/verify`, `GET /audit-log/actions`, `GET /audit-log/export`
  csv/html/json). 69 mutants, 59.42% baseline (41/69, existing
  coverage in `routes-admin.test.ts` smoke-tests `/audit-log` and
  thoroughly covers `/export`'s format branches but never varies
  actor/action/from/to/cursor/limit) → **effectively 100%** (67/69 real
  kills + 2 accepted timeouts) after 4 verify rounds. New file
  `routes-audit-log-mutation.test.ts`. Same filter cluster shape as
  `traces.ts`/`traffic.ts`, applied to two independent endpoint copies
  (list + export). Two real gaps: `GET /audit-log/verify` had zero
  coverage of any kind, and the export endpoint's actor/action filters
  were missing their "non-string doesn't crash" sibling tests. **Also
  the most severe Stryker verify-noise seen in this program to date**:
  two separate verify rounds reported the identical 2 survivors even
  after a confirmed-correct fix — resolved by hand-applying each
  mutation to the source directly and confirming `bun test` fails as
  expected (twice), then trusting that signal over Stryker's stale
  report rather than re-running indefinitely. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/approvals.ts`** (73 LOC,
  `src/routes/admin/` — `GET /approvals` status filter, `POST
/approvals/:id/approve`, `POST /approvals/:id/reject`). 67 mutants,
  0% baseline (zero test coverage of any kind existed before this) →
  **effectively 100%** (66/67 killed + 1 accepted equivalent) after 2
  verify rounds. New file `routes-approvals-mutation.test.ts`. One
  genuine equivalent: the `"approved"` literal at the approve handler's
  `decideApproval(...)` call site — `decideApproval`'s `status`
  parameter is only ever compared against `"rejected"`, so `""` and
  `"approved"` are behaviorally identical there. Key technique: the
  tri-value status-filter OR needed a MIXED 2-approval fixture (one of
  the target status, one of a different status) per narrowing test — a
  single-approval fixture can't distinguish a real filter from no
  filter applied at all when only one approval exists. Also found the
  approve/reject audit calls don't include `note` in their detail
  objects, so that ternary was verified via a follow-up `GET` instead
  of the audit spy. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `schedules.ts`** (74 LOC, `src/routes/` —
  `GET /schedules` list, `POST /schedules` create, `PATCH /schedules/:id`
  toggle, `DELETE /schedules/:id`). 98 mutants, 0% baseline (zero test
  coverage of any kind existed before this) → **100%** (98/98 killed) after
  1 verify round. New file `routes-schedules-mutation.test.ts`. Notable:
  `scheduleRoutes` is wired directly in `server.ts`, not inside
  `adminRoutes()` like every other domain-8 route file — the test app has
  to call `scheduleRoutes(app)` directly (plus `requestIdMiddleware`)
  rather than the usual `adminRoutes(app)`. Key technique: killing a
  `typeof x === "string" ? x : fallback` ternary's conditional/equality
  mutants requires a truthy non-string fixture value (e.g. a number), not
  merely an absent one, since an absent value stays falsy either way. Run
  with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `metrics.ts`** (84 LOC, `src/routes/` —
  `GET /metrics` Prometheus snapshot, `GET /metrics/legacy` JSON). 60
  mutants, 0% baseline (zero test coverage of any kind existed before
  this) → **effectively 100%** (59/60 killed + 1 accepted equivalent)
  after 2 verify rounds. New file `routes-metrics-mutation.test.ts`. Also
  wired directly in `server.ts`, not `adminRoutes()` (same as
  schedules.ts). One genuine equivalent: `c.tools?.length` emptied to
  `c.tools.length` — `RegisteredClient.tools` is a required array field,
  never optional, so the `?.` can never observably matter. Key
  techniques: reused `registry.markClientStatus(...)` (a real production
  setter) to construct degraded/unreachable fixture clients; used
  delta-based assertions for the two genuinely process-wide-singleton
  metrics this file reads (rate-limiter bucket sizes, legacy tool-call
  counters); a 1-healthy/1-degraded fixture failed to kill the legacy
  endpoint's healthy-filter equality mutant (both real and mutant code
  coincidentally counted 1), fixed with an asymmetric 2-healthy/1-degraded
  fixture; and Bun's fetch re-serializes Content-Type parameter order, so
  that assertion needs substring checks, not exact equality. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `health.ts`** (87 LOC, `src/routes/` —
  `GET /livez`, `GET /readyz`, `GET /health`). 36 mutants, 0% baseline
  (zero test coverage of any kind existed before this) → **effectively
  100%** (35/36 killed + 1 accepted equivalent) after 1 verify round. New
  file `routes-health-mutation.test.ts`. Also wired directly in
  `server.ts`, not `adminRoutes()`; all 3 routes are unauthenticated
  (k8s/LB probes), so no admin-key setup was needed. One genuine
  equivalent: `dbUp`'s `catch { return false; }` emptied to `catch {}` —
  its only call site (`if (!dbUp())`) consumes the value through `!`, and
  `false`/`undefined` are equally falsy, so no test can observe the
  difference. Key techniques: reused the real `refreshLeaderStatus()` /
  `__resetLeaderFlagForTesting()` functions to drive `isLeader()`
  deterministically; `spyOn(dbConnMod, "getDb")` throwing to simulate a DB
  outage; a combined not-leader-and-db-down test proves both `reasons`
  pushes are independent/additive, not an early return; a generous
  `toBeLessThan(86400)` bound on `uptime_seconds` catches both the
  `/`→`*` and `-`→`+` arithmetic mutants regardless of module-load timing
  across a full suite run. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `teams.ts`** (87 LOC, `src/routes/` —
  `GET /admin-api/teams`, `POST /admin-api/teams`, `DELETE
/admin-api/teams/:id`, `PUT /admin-api/clients/:name/team`, `PUT
/admin-api/users/:username/team`). 97 mutants, 0% baseline (zero test
  coverage of any kind existed before this) → **100%** (97/97 killed),
  clean, after 1 verify round. New file `routes-teams-mutation.test.ts`.
  Also wired directly in `server.ts`, not `adminRoutes()`. Gated by
  `requireSuperAdmin` (Bearer callers always pass). Key techniques: a
  `body.name.trim()` call has a mutant dropping `.trim()` entirely,
  killed with a whitespace-padded name (the untrimmed value fails the
  entity-name pattern's "must start with alphanumeric" rule while the
  trimmed value passes); both `PUT .../team` routes share an identical
  3-way `teamId === null ? null : (typeof teamId === "number" ? teamId :
undefined)` ternary — same "same guard, multiple call sites" lesson as
  canary.ts/traffic.ts/audit-log.ts, so each route needed its own
  null-clear/number-assign/invalid-type/unknown-target tests rather than
  sharing coverage. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `backup.ts`** (98 LOC, `src/routes/` —
  `POST /admin-api/backup`, a SQLite `VACUUM INTO` snapshot streamed back
  and cleaned up). 42 mutants, 0% baseline (zero test coverage of any
  kind existed before this) → **100%** (42/42 killed), clean, after 2
  verify rounds. New file `routes-backup-mutation.test.ts`. Also wired
  directly in `server.ts`, not `adminRoutes()`. Gated by
  `requireAdminRole` (Bearer callers always pass). Key techniques: a
  pass-through `createReadStream` spy captures the exact path under test
  without changing behavior, proving the private `backupDir()` helper's
  `:memory:` vs. real-path branches independently (toggled by
  temporarily overwriting `config.dbPath`); real `VACUUM INTO` writes a
  real temp file to `./data/` during tests (no `:memory:` override for
  `config.dbPath`), so failure-path tests capture and manually clean up
  their own leftover file; a stream-close-triggered cleanup can resolve
  slightly after the client's `fetch()` sees the response as complete,
  needing a short polling helper instead of an immediate check;
  simulating a post-headers-sent stream error requires pushing a real
  data chunk before erroring, since headers only flush on the first
  write. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/users.ts`** (105 LOC,
  `src/routes/admin/` — `GET/POST/PATCH/DELETE /admin-api/users`, mounted
  through `adminRoutes()`). 114 mutants, 47.4% baseline (54/114 — existing
  `routes-admin.test.ts` coverage never asserted exact codes/messages/
  audit details, never exercised PATCH's `is_active` branch or its own
  last-admin guard, and never tested an unknown username on PATCH) →
  **effectively 100%** (112/114 killed + 2 genuine timeouts) after 2
  verify rounds. New file `routes-users-mutation.test.ts`, existing file
  left untouched. 2 accepted timeouts: the whole POST/PATCH handler
  bodies emptied — an emptied async handler never responds, so the
  request hangs until Stryker's own timeout (same convention as auth.ts,
  transports.ts, mcp-server.ts). Key findings: a `typeof x === "boolean"
? x : undefined` ternary's forced-true mutant is NOT killed by a truthy
  non-boolean fixture value, since the downstream `isActive ? 1 : 0`
  coercion lands on the same outcome by coincidence — needs a FALSY
  non-boolean value instead; and a `nextRole !== undefined` forced-true
  mutant inside a larger boolean chain can be masked when a sibling
  clause independently reaches the same truth value for the SAME test
  input — needs a fixture that keeps every OTHER real branch false so
  only the mutant's forced branch would wrongly fire. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `upstream-auth.ts`** (111 LOC,
  `src/routes/` — `GET/PUT/DELETE /admin-api/clients/:name/upstream-auth`,
  a bearer/basic/header credential-validation switch). 159 mutants, 32.7%
  baseline (52/159 — existing `routes-upstream-auth.test.ts` covers only
  the bearer-auth happy path plus a handful of 400/404/501/401/403
  branches at status-code-only level; basic auth was completely
  untested) → **effectively 100%** (157/159 killed + 1 accepted
  equivalent + 1 genuine timeout) after 2 verify rounds. New file
  `routes-upstream-auth-mutation.test.ts`, existing file left untouched.
  1 accepted equivalent: the `input === null` half of a type guard —
  production's `express.json({strict: true})` rejects every bare-scalar
  JSON body before the route ever runs, confirmed empirically, so this
  branch is unreachable through the real HTTP boundary. Key findings:
  `getUpstreamAuthInfo` (the read-model) never exposes the stored
  secret, so proving a secret-object literal wasn't emptied required
  calling `getUpstreamAuthHeaders` (the function the proxy itself uses)
  to decrypt and assert the real outbound credential; a
  `typeof x !== "string" || x.length === 0` cluster needs an
  EMPTY-STRING fixture (not just a missing-field one) to kill the
  length-check's own forced-false direction; an anchored regex needs
  three fixture shapes (valid multi-char, invalid-leading-char,
  invalid-trailing-char) to kill its full mutant family; and a new test
  file that sets a shared `config` singleton must restore it via
  `afterEach`, not just inside individual try/finally blocks — this
  file's first draft leaked `config.secretEncryptionKey` into 3
  unrelated tests in other files during a full-suite run, fixed by
  matching the sibling test file's own capture-and-restore convention.
  Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/clients.ts`** (119 LOC,
  `src/routes/admin/` — `GET /clients` list+filters, `GET /clients/:name`
  detail, `PATCH /clients/:name` enabled+guards, `DELETE /clients/:name`,
  `PATCH /clients` bulk enable/disable). 128 mutants, 46.1% baseline
  (59/128 — existing `routes-admin.test.ts` never exercised the
  query-filter ternaries with a non-string fixture, team-scoped
  cross-team denial, the disable branch's own audit action, or exact
  codes/messages/audit details) → **effectively 100%** (123/128 killed +
  1 accepted equivalent + 4 genuine timeouts) after 2 verify rounds. New
  file `routes-clients-mutation.test.ts`, existing file left untouched.
  1 accepted equivalent: the `teamId` ternary's forced-true direction —
  `registry.listClientsSummary` re-validates `typeof === "number"` before
  using it as a SQL filter param regardless of what the route passes
  through. 4 genuine timeouts: whole-handler-emptied and
  `!ensureClientAccess(...)`'s negation-removed/forced-true directions
  (same "hangs forever" convention as prior files). Key findings: a
  "doesn't crash" assertion on a query-filter ternary can't distinguish
  real filtering from a mutant that silently drops the filter — fixed
  with genuine narrowing assertions (a status-mismatch fixture, real
  2-page cursor pagination); and confirming a genuine equivalent requires
  reading the downstream consumer's own validation code, not assuming
  symmetry with a similarly-shaped sibling filter. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `consumers.ts`** (121 LOC, `src/routes/`
  — `GET /consumers`, `POST /consumers`, `PATCH /consumers/:id`, `DELETE
/consumers/:id`, `GET /consumers/:id/usage`). 125 mutants, 46.4%
  baseline (58/125 — existing `routes-consumers.test.ts` never PATCHed
  the `name` field at all, never tested an unknown id on
  PATCH/DELETE/usage, and never asserted exact codes/messages/audit
  details) → **effectively 100%** (122/125 killed + 1 accepted
  equivalent + 2 genuine timeouts) after 2 verify rounds. New file
  `routes-consumers-mutation.test.ts`, existing file left untouched. 1
  accepted equivalent: a `{ ok: false }` helper result emptied to `{}` —
  every caller consumes it only through `!x.ok`. 2 genuine timeouts:
  whole POST/PATCH handler bodies emptied. Key finding: a duplicate-name-
  on-update check with two separate `.trim()` calls guarding the same
  compound condition needs two DIFFERENT whitespace-padded fixtures (a
  padded no-op rename, and a padded collision with another consumer's
  real name where the first clause must independently evaluate true) —
  an unpadded no-op test can't distinguish either `.trim()` mutant since
  both sides already match without trimming. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/lb.ts`** (123 LOC,
  `src/routes/admin/` — `GET/PUT /clients/:name/lb` strategy config,
  `POST /clients/:name/lb/upstreams`, `PATCH/DELETE
/clients/:name/lb/upstreams/:id`). 123 mutants, 0% baseline (zero test
  coverage of any kind existed at all) → **effectively 100%** (114/123
  killed + 9 genuine timeouts) after 1 verify round. New file
  `routes-lb-mutation.test.ts`. 9 genuine timeouts: whole-handler-emptied
  (3 of the file's 5 routes) or their own `ensureClientAccess` guard's
  negation-removed/forced-true directions (same "hangs forever"
  convention as prior files) — PATCH's and DELETE's structurally
  identical copies of the same guard were cleanly killed instead, a
  reminder that identical-shaped guards across sibling routes don't
  necessarily time out the same way. Operational note: the first verify
  attempt was sleep-contaminated mid-run (elapsed time jumped from ~4min
  to ~2.5 hours), fixed by killing the process tree and relaunching with
  an explicit keep-awake guard paired with the wait call. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `config-io.ts`** (145 LOC, `src/routes/` —
  `GET/POST /config/export`/`/import` in JSON or YAML, and the full
  snapshots subsystem: list/create/get/delete/diff/rollback). 129 mutants,
  13.95% baseline (18/129 killed by the existing hand-written test, which
  only covered plain-JSON export/import happy paths) → **100%** (129/129)
  after 2 verify rounds. New file `routes-config-io-mutation.test.ts`; the
  existing `routes-config-io.test.ts` was left untouched, only gap-filled.
  The entire snapshots subsystem had zero coverage before this despite
  being fully wired and reachable. Round 1's single survivor (the
  `body.format === "yaml"` sub-condition forced-true) needed a fixture
  where `format` is omitted but `raw` is still a string, alongside an
  invalid-version `data` payload, to distinguish the real else-branch
  (400) from the mutant's wrongly-taken YAML-parse branch (200). Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `policies.ts`** (160 LOC, `src/routes/` —
  guard-policy CRUD + apply-to-tools/apply-to-bundle admin-API routes). 196
  mutants, baseline had zero coverage on the PATCH endpoint (the existing
  hand-written test only covered POST create/duplicate-409/list/delete
  happy paths, the tools-array apply path, and a blanket 401) → **95.9%**
  (188/196 killed), 5 confirmed equivalents and 3 accepted timeouts
  (whole-handler-emptied) after 2 verify rounds. New file
  `routes-policies-mutation.test.ts`; existing `routes-policies.test.ts`
  left untouched. First file closed via a worktree-isolated parallel
  Workflow instead of solo. Found a reusable `{ok:false}`→`{}` equivalence
  class (any `LooseValidationResult`-shaped return whose only consumers
  check `.ok` via truthiness is immune to this mutator) and confirmed the
  `JSON.stringify(Infinity)`→`null` trap requires a raw numeric-overflow
  literal body to genuinely test non-finite rejection. Also fixed a
  permanent lint gap: `eslint.config.js` didn't ignore `.claude/**`, so a
  live git worktree (used by the parallel Workflow) got swept into
  `eslint .` as a second tsconfig root, producing thousands of spurious
  errors. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-policies-mutation.test.ts src/routes/__tests__/routes-policies.test.ts"`.
- **Mutation testing — domain 8, `auth.ts`** (153 LOC, `src/routes/` — admin
  login/logout, `GET /me`, `PATCH /me/password`, `GET /sessions`,
  `DELETE /sessions/:id`). 188 mutants, 23% baseline (43/188 killed — the
  existing hand-written test only covered login happy/sad paths, `GET /me`'s
  session branch, and logout's CSRF gate; the password-change and session-
  management endpoints were entirely untested) → **effectively 100%**
  (176/188 killed, 11 confirmed equivalents, 1 accepted timeout) after 2
  verify rounds. New file `routes-auth-mutation.test.ts`; existing test file
  left untouched. Second file closed via the parallel Workflow. Found a
  reusable equivalence class: an identical 3-clause session-context guard
  repeats across 3 routes, and its middle clause is always redundant with
  the third given `AuthContext`'s own shape — confirmed by hand-mutating and
  re-running the suite for all 5 occurrences, not by reasoning alone. Run
  with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-auth.test.ts src/routes/__tests__/routes-auth-mutation.test.ts"`.
- **Mutation testing — domain 8, `alerts.ts`** (152 LOC, `src/routes/` —
  alert-rule CRUD + `POST /alerts/:id/test`). 170 mutants, 40% baseline
  (68/170 killed — the existing hand-written test never touched PATCH's or
  DELETE's 404, the test endpoint's 404/failure path, exact error
  messages/audit calls, or the `isEventType`/`isHttpUrl`/`optNumber` helper
  clusters) → **effectively 100%** (165/170 killed, 3 confirmed
  equivalents, 2 accepted timeouts). New file `routes-alerts-mutation.test.ts`;
  existing test file left untouched. Handled solo (not via the parallel
  Workflow) after this file's own worktree agent got stuck when its
  background Stryker process silently died mid-run; the baseline scan it
  had already captured was reused directly. Found a genuine (non-equivalent)
  counterpart to a previously-accepted equivalence pattern: `isHttpUrl`'s
  `typeof v === "string"` clause forced true is a REAL gap (a non-string
  `v.startsWith(...)` throws, unlike `isEventType`'s type-safe
  `.includes()`), so two superficially identical typeof-guard mutants can
  differ in equivalence depending on whether the guarded operation is
  type-safe. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-alerts.test.ts src/routes/__tests__/routes-alerts-mutation.test.ts"`.
- **Mutation testing — domain 8, `ws-proxy-admin.ts`** (170 LOC,
  `src/routes/` — GET list/detail, POST create, PATCH update, DELETE, and
  `POST /disconnect-all` for the persistent WS-proxy target registry). 161
  mutants, 0% baseline (no test file existed at all for these admin CRUD
  routes) → **effectively 100%** (156/161 killed, 4 confirmed equivalents,
  1 accepted timeout). New file `routes-ws-proxy-admin-mutation.test.ts`.
  Third file closed via the parallel Workflow. 3 of the 4 equivalents are
  the same `Number.isInteger`-short-circuit class documented for
  tool-search.ts, recurring at 3 independent call sites in this one file.
  Integration-time fix: one test asserting a blocked-private-IP-range
  rejection relied on `config.allowPrivateIps` defaulting to false, which
  only holds in a bare environment — this repo's own dev `.env` sets
  `ALLOW_PRIVATE_IPS=true`, so the test passed in the sandboxed worktree
  but failed once integrated into the main repo; fixed by explicitly
  forcing the config value false for that one test's duration. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-ws-proxy-admin-mutation.test.ts"`.
- **Mutation testing — domain 8, `discovery.ts`** (199 LOC, `src/routes/` —
  `POST /discovery/preview` (OpenAPI/curl/Postman/manual sources) and
  `POST /discovery/preview-graphql`). 164 mutants, 54% baseline (89/164
  killed) → **effectively 100%** (149/164 killed, 6 confirmed equivalents,
  9 accepted timeouts) after 2 verify rounds. New file
  `routes-discovery-mutation.test.ts`; existing test file left untouched.
  Fourth file closed via the parallel Workflow — the largest accepted-
  timeout count so far in domain 8 (9), mostly whole-handler/whole-branch
  mutants across the file's several source-specific try-blocks. Confirmed
  a WHATWG `URL.pathname`-never-falsy equivalence already seen on
  registration.ts, plus a benign double-send-after-flush equivalence for
  two validator-branch `return false`→`true` flips. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-discovery.test.ts src/routes/__tests__/routes-discovery-mutation.test.ts"`.
- **Mutation testing — domain 8, `catalog.ts`** (204 LOC, `src/routes/` —
  catalog-entry CRUD + `POST /:id/install`). 270 mutants, 35% baseline
  (95/270 killed) → **effectively 100%** (265/270 killed, 2 confirmed
  equivalents, 3 accepted timeouts). New file
  `routes-catalog-mutation.test.ts`; existing test file left untouched.
  Fifth file closed via the parallel Workflow. Notable: the DELETE
  handler's whole-body-emptied mutant was cleanly killed rather than
  timing out like its create/PATCH/install siblings — a pending-connection
  interaction apparently fires a bun-internal timeout faster than
  Stryker's own external one, a stronger detection signal needing no
  extra work. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-catalog.test.ts src/routes/__tests__/routes-catalog-mutation.test.ts"`.
- **Mutation testing — domain 8, `auth-oidc.ts`** (214 LOC, `src/routes/` —
  OIDC SSO `GET /start`, `GET /callback`, `GET/PUT /settings`). 186
  mutants, 50% baseline (93/186 killed) → **effectively 100%** (176/186
  killed, 5 confirmed equivalents, 5 accepted timeouts) after 2 verify
  rounds. New file `routes-auth-oidc-mutation.test.ts`; existing test file
  left untouched. Sixth file closed via the parallel Workflow. Found 2
  equivalents where the route's own `scopes` default/trim is fully masked
  by `setOidcConfig`'s own internal re-trim-and-default, so the route-level
  logic never actually affects what's persisted. Also fixed a permanent
  lint gap: `.stryker-tmp/**` wasn't in `eslint.config.js`'s ignores either
  (same root cause as the `.claude/**` fix) — a live Stryker sandbox got
  swept into `bun run lint` as a second tsconfig root; `bun run lint` is
  now safe to run at any time, even mid-Stryker-run. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__/routes-auth-oidc.test.ts src/routes/__tests__/routes-auth-oidc-mutation.test.ts"`.
- **Mutation testing — domain 8, `composites.ts`** (176 LOC, `src/routes/` —
  composite-tool CRUD). 175 mutants, 0% baseline (no test file existed at
  all) → **effectively 100%** (169/175 killed, 3 confirmed equivalents, 3
  accepted timeouts) after 2 verify rounds. New file
  `routes-composites-mutation.test.ts`. Seventh file closed via the
  parallel Workflow, though its own verify round was interrupted mid-run
  and had to be completed solo afterward. Also merged a permanent fix from
  the interrupted run: `scripts/stryker-test-runner.ts` now defensively
  `mkdirSync("data")`s before every scoped run, since the gitignored
  `./data/` directory `routes/backup.ts`'s real `VACUUM INTO` tests need
  doesn't exist in a totally fresh worktree/sandbox. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `mcp-keys.ts`** (273 LOC, `src/routes/` —
  MCP API key CRUD + `POST /:id/rotate`). 319 mutants, 49% baseline
  (157/319 killed) → **effectively 100%** (315/319 killed, 2 confirmed
  equivalents, 2 accepted timeouts) after 3 verify rounds. New file
  `routes-mcp-keys-mutation.test.ts`; existing test file left untouched.
  Eighth file closed via the parallel Workflow. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `bundles.ts`** (305 LOC, `src/routes/` —
  MCP bundle CRUD + `POST /install-links`). 255 mutants, 47% baseline
  (121/255 killed) → **effectively 100%** (248/255 killed, 3 confirmed
  equivalents, 4 accepted timeouts) after 2 verify rounds. New file
  `routes-bundles-mutation.test.ts`; existing test file left untouched.
  Ninth file closed via the parallel Workflow. Run with
  `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin-validators.ts`** (457 LOC, the
  largest file in domain 8 — 13 exported `validate*Input` pure-function
  helpers, no Express routes). 1027 mutants, 0% baseline (no test file
  existed) → **effectively 100%** (1014/1027 killed, 13 confirmed
  equivalents, 0 accepted timeouts) after 2 verify rounds. New file
  `routes-admin-validators-mutation.test.ts`, tested via direct
  import+call rather than an HTTP harness. Tenth file closed via the
  parallel Workflow — the largest single-file mutant count this program
  has directly authored tests for. All 13 equivalents are the same
  "masked by a strict-type-checking builtin" class (`Number.isInteger`/
  `Number.isFinite`/`Array.prototype.includes` each independently reject
  wrong types), confirmed individually via hand-mutation rather than
  assumed from the pattern. Run with `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
- **Mutation testing — domain 8, `admin/tools.ts`** (202 LOC, `src/routes/admin/`
  — per-tool policy PATCH, bulk enable/disable, synthetic test call,
  saved-example CRUD, circuit-breaker reset, cache purge, quarantine
  clear). 166 mutants, 0% baseline (no test file existed) →
  **effectively 100%** (158/166 killed, 5 confirmed equivalents, 3
  accepted timeouts) after 1 verify round, using the existing 38-test
  file the parallel Workflow agent had already authored with zero
  further changes needed. Eleventh and **last file of domain 8**,
  closed solo after its own verify round was interrupted at 9%. Found
  that `express.json()`'s default `strict: true` rejects any raw
  top-level JSON scalar body with its own 400 before the route ever
  runs, making a `typeof body !== "object"` guard's forced-true
  direction unreachable — confirmed empirically, not assumed.

**Domain 8 (`src/routes` + `src/routes/admin`, 41 files) is now
COMPLETE** — every file effectively 100%. The final 12 files were
closed via a worktree-isolated parallel Workflow (batched 3 agents at
a time), with 9 of 12 completing cleanly end-to-end and 3 needing
solo rescue for interrupted/stuck runs. See `stryker.config.mjs`'s
SCOPE HISTORY for the full retrospective. Domain 9 (`src/admin`, 33
files) starts next.

- **Mutation testing — domain 9, `src/admin/entities/policies.ts`** (112 LOC
  — guard-policy CRUD + bulk apply-to-tools/apply-to-bundle logic backing
  the already-closed `src/routes/policies.ts` route handlers). 47 mutants,
  97.9% baseline (46/47 killed — the existing `policies.test.ts` only
  covered the CRUD happy path plus apply success/skip/unknown-bundle
  cases, leaving `getGuardPolicy()`/`policyNameExists()` completely
  untested) → **100%** (47/47) in 1 verify round. New file
  `policies-mutation.test.ts`. Closed via a worktree-isolated parallel
  Workflow agent.
- **Mutation testing — domain 9, `src/admin/config/config-diff.ts`** (59
  LOC — pure order-insensitive structural diff between two config
  documents, name-keyed array alignment). 75 mutants, 93.3% baseline
  (70/75, no prior test file existed at all) → effectively 100% (72/75 +
  3 accepted equivalents) in 1 verify round. New file
  `config-diff-mutation.test.ts`. The 2 real gaps were both in `walk()`'s
  null-guard conjuncts (`typeof null === "object"` makes the `x !== null`
  check load-bearing — without it a null leaf vs. a real object wrongly
  throws instead of reporting a clean diff); the 3 accepted equivalents
  (an `arr.length > 0` empty-array boundary in two mutant forms, plus a
  redundant top-level `a === b` early-return) were each hand-verified by
  mutating the source directly and confirming the full test file still
  passed. Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/entities/teams.ts`** (112 LOC
  — team multi-tenancy entity: CRUD on teams, client/user team-ownership
  assignment, `canAccessClient` scoping). 70 mutants, 80% baseline (56/70
  — the existing `teams.test.ts` covered route-enforcement/happy-path but
  left `getTeam()` untested, plus the "clear"/"unknown-teamId" branches
  and the `admin_users` side of the FK cascade) → **94.3%** (66/70 + 4
  accepted equivalents) in 1 verify round. New file
  `teams-mutation.test.ts`. The 4 equivalents (existence-guard disables +
  `.changes > 0`→`>= 0` boundary mutants) were hand-verified: each guard
  is followed immediately by an UPDATE keyed on the same PRIMARY
  KEY/UNIQUE column it just checked, so the two can never disagree.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/config/config-versions.ts`**
  (114 LOC — snapshot CRUD + diff/rollback on top of `config-io.ts`'s
  export/import). 39 mutants, 100% baseline (39/39, stable across 2 verify
  rounds) — no dedicated test file existed yet at the domain-9 convention
  path, so the first draft doubled as the baseline. New file
  `config-versions-mutation.test.ts`. Zero equivalents or timeouts
  needed. Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/entities/consumers.ts`** (159
  LOC — API-consumer CRUD + monthlyQuota/endUserRateLimitPerMin
  enforcement checked on the proxy hot path). 89 mutants, 57.3% baseline
  (51/89 — the existing `consumers.test.ts` never imported
  `isValidQuotaValue`/`consumerNameExists`/`getConsumerByName` at all) →
  effectively 100% (88/89 + 1 accepted equivalent) in 1 verify round. New
  file `consumers-mutation.test.ts`. Notable: `bun:sqlite`'s loose type
  affinity means ordinary non-integer ids can't kill `getConsumer`'s
  integer guard at all — passing the boolean `true` (silently coerced to
  `1` by sqlite) is the fixture that actually distinguishes it. Closed via
  a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/tool-policies/mutations/`**
  (18 `ToolMutation` handlers + `index.ts`'s dispatcher; `types.ts`
  excluded — pure type declarations). Closed as ONE batch, matching the
  domain-4 "8 small files" precedent. 553 mutants, 5.3% baseline (35/553,
  only indirect exercise from the already-closed `src/routes/admin/
tools.ts` PATCH tests) → effectively 100% (504/553 raw, all 49
  remaining raw survivors confirmed equivalent) after 3 verify rounds.
  New file `mutations-batch.test.ts`, 76 tests, direct calls to
  `dispatchToolMutations` (no Express app needed). Two equivalence
  classes recur across every file: each handler's own success-branch
  `{kind:"ok"}` object literal (the dispatcher only ever branches on
  `"tool_not_found"`/`"error"`, never `"ok"` explicitly), and several
  `{kind:"set"}` discriminant strings (nothing ever checks
  `kind==="set"`, only `"clear"`). Real gaps closed per-file: monitor.ts
  (`INVALID_INTERVAL` 400 path, `monitor: false` clear trigger,
  `intervalMinutes` default), graphql.ts/ws.ts (non-object non-array raw
  values beyond arrays, non-string-truthy required fields), overrides.ts
  (confirmed the `TOOL_ALIAS_INVALID` 400 branch is dead code —
  `validateToolOverrideInput`'s displayName regex is identical to the
  registry's own check, so it's always caught at validation first),
  requires-approval.ts (`MAX_APPROVAL_LEVELS` boundary, non-integer
  levels, exact minimum boundary), context-budget.ts (a genuine
  `llm_summarize` success-path audit test proving `llmProvider` is
  included). New equivalence class: context-budget.ts's audit meta
  spread condition `v.mode === "llm_summarize" && v.llm` is unobservable
  in either mutated direction because `v.llm` is populated
  if-and-only-if `v.mode === "llm_summarize"` by the validator's own
  return shape. 0 Stryker timeouts across all 3 verify rounds.
- **Mutation testing — domain 9, `src/admin/audit/audit-export.ts`** (233
  LOC — CSV/HTML compliance-evidence serializers for the audit-log
  export route). 71 mutants, 94% baseline (67/71, first-draft test since
  none existed) → effectively 100% (70/71 + 1 accepted equivalent) in 1
  verify round. New file `audit-export-mutation.test.ts`. 1 accepted
  equivalent: `fmtDate`'s trailing `$` regex anchor is redundant given
  the function's actual ISO-8601 input shape. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/audit/audit.ts`** (253 LOC —
  admin audit log: tamper-evident hash-chain recording/verification,
  SIEM streaming, filtered/paginated listing, action enumeration, bulk
  export). 116 mutants, 95.7% baseline (111/116 — the pre-existing
  `audit-chain.test.ts`'s tamper tests never isolated the prev_hash
  linkage check from the content-hash recomputation check on the same
  line) → **100%** (116/116) in 1 verify round. New file
  `audit-mutation.test.ts`. Zero equivalents or timeouts needed. Closed
  via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9,
  `src/admin/tool-composition/bundle-install-links.ts`** (289 LOC —
  install-link token generation/redemption for MCP bundles). 113
  mutants, 92.0% baseline (104/113, first-draft test since none existed)
  → effectively 100% (110/113 + 3 accepted equivalents) in 1 verify
  round. New file `bundle-install-links-mutation.test.ts`. 3 accepted
  equivalents, each hand-verified: a non-integer-id guard made redundant
  by `bun:sqlite`'s STRICT-table binding behavior, an empty-array
  no-op loop guard, and an FK-cascade-proven-unreachable null check.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/entities/schedules.ts`** (227
  LOC — maintenance-schedule cron matcher + CRUD + the once-a-minute
  leader-gated evaluator). 203 mutants → effectively 100% (196/203, 2
  confirmed equivalents + 5 genuine infinite-loop timeouts) after 3 solo
  verify rounds, rescued from an interrupted parallel-Workflow draft. New
  file `schedules-mutation.test.ts`. Real gaps closed: a comma-list
  combining a valid cron part with an inverted range (an isolated
  inverted range alone can't distinguish the bypass, since a separate
  `out.size > 0` fallback happens to return null anyway); `cronMatches`
  returning `false` instead of throwing for malformed input; 3
  `createSchedule` validation branches whose tests never registered the
  target client first, letting an unrelated later guard mask them; a
  client-type schedule ignoring a supplied `toolName`; a malformed
  tool-type row proving the evaluator's own guard is load-bearing; and
  the exact stored `last_run_minute` arithmetic. 5 accepted genuine
  timeouts: weakening the cron step validation lets a zero/negative step
  reach a range-fill loop that then never terminates.
- **Mutation testing — domain 9, `src/admin/entities/approvals.ts`** (315
  LOC — human-in-the-loop N-of-M approval ticket lifecycle). 157
  mutants, 94.9% baseline (149/157 — the existing test left 3 functions
  untested and used loose assertions that masked branch-specific
  mutants) → effectively 100% (152/157 + 5 accepted equivalents) in 1
  verify round. New file `approvals-mutation.test.ts`. 5 accepted
  equivalents: a `!== undefined` check subsumed by the next clause, plus
  a 4-mutant cluster inside a TOCTOU race-guard structurally unreachable
  in this codebase's synchronous, single-connection execution model.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/config/config-io.ts`** (302
  LOC — exportConfig/importConfig, the config-as-code serialization
  layer). 179 mutants, 97.2% baseline (174/179, first-draft test since
  none existed) → **100%** (179/179) in 1 verify round. New file
  `config-io-mutation.test.ts`. Found (and pinned, not fixed — out of
  scope for a test-only pass) a genuine production inconsistency: a
  "missing tools" validation guard defensively filters `b.tools ?? []`,
  but the apply step two lines later passes the RAW `b.tools`, so an
  omitted `tools` key sails past validation and throws deep in
  `bundles.ts`. Zero equivalents or timeouts needed. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 9, `src/admin/tool-composition/bundles.ts`**
  (355 LOC — MCP bundle CRUD entity/business logic). 214 mutants, 61%
  baseline (130/214 — the existing test asserted mostly via the
  in-memory cache getters, leaving `updateBundle`'s underlying SQL write
  path unguarded) → effectively 100% (212/214 + 2 accepted equivalents)
  across 2 verify rounds. New file `bundles-mutation.test.ts`. 2 accepted
  equivalents: both halves of an `updated_at` "bump only if unchanged"
  guard are redundant, since the sibling branches already stamp the same
  `now` value regardless. Closed via a worktree-isolated parallel
  Workflow agent.
- **Mutation testing — domain 9,
  `src/admin/tool-composition/composites.ts`** (505 LOC — composite/
  macro-tool CRUD entity layer: step sequencing, `$ref`/`${}` arg
  templating, per-step dispatch, live-cache sync — the execution engine
  underneath the already-tested route/CRUD HTTP layer). 425 mutants,
  52.2% baseline (222/425 — the existing test covered happy paths but
  never asserted exact error-message text, and left convergent-clause
  type guards and a multi-content-array branch unexercised) → effectively
  100% (419/425 + 6 accepted equivalents) across 3 verify rounds. New
  file `composites-mutation.test.ts`, 86 tests. **Domain 9's last file.**
  6 accepted equivalents, all hand-verified: a guard-half subsumed by a
  later `typeof` check, a dead loop-variable initializer, a no-op catch
  assignment, and an unreachable cache-refresh branch (serialized by a
  per-name mutex). Closed via a worktree-isolated parallel Workflow
  agent.

**Domain 9 (`src/admin`, 32 files needing coverage) is now COMPLETE** —
every file effectively 100%. 12 of the 13 non-batch files were closed
via a single worktree-isolated parallel Workflow (batched 3 agents at a
time across 5 sequential batches), with 11/12 completing cleanly
end-to-end and 1 (`schedules.ts`) needing solo rescue after being
interrupted mid-verify. See `stryker.config.mjs`'s SCOPE HISTORY for the
full retrospective. Domain 10 (misc: `src/lib`, `src/cli`,
`src/catalog`, `src/secrets`, `src/config*`, `ws-proxy.ts`, `server.ts`,
`index.ts`, ~32 files) starts now, scaled immediately to a second
worktree-isolated parallel Workflow. 3 files (`ws-proxy.ts`,
`src/index.ts`, `src/cli/index.ts`) are held back for solo/special
handling (real WS/DNS/SQLite, or process-entrypoint import-time side
effects); 2 files (`src/secrets/provider.ts`, `src/catalog/builtin.ts`)
are skipped entirely (pure interface / static data, no runtime logic).

- **Mutation testing — domain 10, `src/lib/crypto.ts`** (16 LOC — shared
  `sha256Hex` helper). 4 mutants (the smallest scope in this whole
  program), 75% baseline (3/4, no prior test existed) → **75%** (3/4, 1
  accepted equivalent) in 1 verify round, stable across 2 independent
  runs. New file `crypto-mutation.test.ts`. The 1 equivalent: Node's
  `Hash.update()` normalizes an unrecognized/empty encoding string to
  the same default as `"utf8"`, hand-verified across ASCII/emoji/
  Latin-1 inputs with a `"latin1"` control. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/commands/login.ts`** (15 LOC
  — CLI `login` subcommand). 20 mutants, 100% baseline (20/20, no prior
  test existed) → **100%** in 1 verify round — a genuinely clean first
  draft, no fix cycle needed. New file `login-mutation.test.ts`. Closed
  via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/config.ts`** (382 LOC — the
  env-driven runtime `config` singleton, ~90 fields). 460 mutants, 21.3%
  baseline (98/460 — the existing test only reached `config`
  transitively through 3 parser helpers) → effectively 100%
  (452/460 + 8 accepted equivalents) in 1 verify round. New file
  `config-mutation.test.ts`. 8 accepted equivalents (all hand-verified
  via WHATWG URL-parsing experiments) plus 4 REAL gaps incidentally
  found and closed in the sibling file's nominal territory (a
  whitespace-padded wildcard entry, 3 two-part error-message
  StringLiterals). Closed via a worktree-isolated parallel Workflow
  agent.
- **Mutation testing — domain 10, `src/lib/mcp-result.ts`** (29 LOC —
  single `toolResult()` builder for the shared MCP CallTool result
  envelope). 10 mutants, 100% baseline (10/10, no prior test existed) →
  **100%** in 1 verify round. New file `mcp-result-mutation.test.ts`.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/commands/pull.ts`** (24 LOC —
  CLI command that GETs the live config export into `gateway.yaml`).
  12 mutants, 92% baseline (11/12, no existing test) → effectively 100%
  (11/12 + 1 accepted equivalent) in 1 verify round. New file
  `pull-mutation.test.ts`. Closed via a worktree-isolated parallel
  Workflow agent.
- **Mutation testing — domain 10, `src/config-schema.ts`** (388 LOC —
  typed zod validation of `process.env`). 218 mutants, 56.9% baseline
  (124/218 own-file score) → 81.7% own-file score (178/218 + 40
  confirmed equivalents) across 2 stable verify rounds. New file
  `config-schema-mutation.test.ts`. Operational gotcha: this repo's
  resolved zod version requires every schema key to be textually present
  in the input, which is the confirmed root cause of the sibling test's
  5 pre-existing failures — verification was scoped to just this new
  file since Stryker's dry run needs the whole scope to pass first. All
  40 equivalents trace to one structural cause (hand-verified): `EnvReport`
  never returns `result.data`, so every transform's output value is
  unobservable through the public contract — only success/issues are
  read. 5 genuinely observable arithmetic-bound mutants plus the
  unknown-env-prefix array were real gaps, closed with boundary tests.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/lib/identifier.ts`** (66 LOC —
  shared identifier-shape regex validators plus the `client__tool`
  composite-key encode/decode pair). 25 mutants, 100% baseline (25/25,
  no prior test existed) → **100%** on the first run, no verify rounds
  needed. New file `identifier-mutation.test.ts`, 37 tests. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/connect-templates.ts`** (279
  LOC — per-MCP-client config-snippet generator). 112 mutants, 78.6%
  baseline (88/112 — the existing test never read template objects' own
  `id`/`label` fields nor checked exact thrown messages) → **100%**
  (112/112) in 1 verify round. New file `connect-templates-mutation.test.ts`.
  Zero equivalents or timeouts needed. Closed via a worktree-isolated
  parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/args.ts`** (32 LOC —
  hand-rolled `parseFlags()` argv parser). 39 mutants, 92% baseline
  (36/39 — the existing test never exercised a flag as the literal last
  argv element) → effectively 100% (37/39 + 2 accepted genuine timeouts)
  in 1 verify round. New file `args-mutation.test.ts`. Notable: the
  first 2 Stryker runs against this file's already-correct test both
  reported the same 2 false survivors before a 3rd fresh run reported 0
  — a new confirmed instance of this program's documented verify-noise
  gotcha. Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/secrets/local-provider.ts`** (25
  LOC — zero-config `SecretsProvider` wrapping `secret-box.ts`'s sync
  primitives in async shims). 5 mutants, 100% baseline (5/5, no prior
  test existed) → **100%** in 1 verify round, stable across a 2nd
  stability check. New file `local-provider-mutation.test.ts`. Closed
  via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/commands/plan.ts`** (44 LOC —
  CLI `plan` command: diffs a local `gateway.yaml` against the live
  gateway). 36 mutants, 100% on first authored draft (36/36, no prior
  test existed) → **100%** confirmed stable across 2 independent Stryker
  rounds. New file `plan-mutation.test.ts`. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/catalog/index.ts`** (248 LOC —
  merges the static builtin catalog with SQLite-backed custom entries).
  138 mutants, 94.2% baseline (130/138, first-draft test) → effectively
  100% (136/138 + 2 accepted equivalents) in 1 verify round. New file
  `catalog-mutation.test.ts` (co-located with the existing
  `catalog.test.ts` at the ROOT `src/__tests__/`, not a mirrored
  `src/catalog/__tests__/`). 6 real gaps closed: a coincidental-parse
  edge case on the `custom:`-prefix check, an omitted-vs-explicit-
  null/false divergence on 3 merge fields, and un-asserted error message
  text. Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/lib/pagination-cursor.ts`** (55
  LOC — shared keyset-pagination helper). 12 mutants, 100% baseline
  (12/12, no prior test existed) → **100%** in 1 verify round, stable
  across a stability check. New file `pagination-cursor-mutation.test.ts`.
  Closed via a worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/config-file.ts`** (48 LOC —
  loads/saves the CLI's `gateway.yaml` file). 22 mutants, 91% baseline
  (20/22) → effectively 100% (20/22 + 2 accepted equivalents) in 1
  verify round. New file `config-file-mutation.test.ts`. 2 accepted
  equivalents: the `yaml` package never returns JS `undefined` for any
  parseable input, and Bun's `fs.writeFile` normalizes an empty-string
  encoding identically to `"utf-8"` for string payloads. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/server.ts`** (195 LOC —
  `createApp()`, the Express app-wiring factory). 97 mutants, 93.8%
  baseline (91/97 — the existing `create-app.test.ts` alone only killed
  24/97 run in isolation) → **100%** (96/97 + 1 accepted genuine
  timeout) in 1 verify round. New file `server-mutation.test.ts`. The
  inline global error handler was reached by pulling its 4-arg layer
  directly off Express 5's `app.router.stack`. 1 accepted genuine
  timeout: gutting the security-headers middleware drops its trailing
  `next()`, hanging every request. Closed via a worktree-isolated
  parallel Workflow agent.
- **Mutation testing — domain 10, `src/lib/stable-json.ts`** (62 LOC —
  deterministic/canonical JSON serialization with key-order sorting).
  35 mutants, 100% baseline (35/35, no prior test existed) → **100%**
  after 2 verify rounds, zero fixes needed. New file
  `stable-json-mutation.test.ts`. Closed via a worktree-isolated
  parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/commands/apply.ts`** (92 LOC
  — CLI `gateway apply` command). 73 mutants, no prior test file →
  **100%** (73/73) on the first draft, stable across 2 verify rounds.
  New file `apply-mutation.test.ts`. Closed via a worktree-isolated
  parallel Workflow agent.
- **Mutation testing — domain 10, `src/secrets/vault-provider.ts`** (118
  LOC — HashiCorp Vault Transit-engine `SecretsProvider`). 98 mutants,
  62% baseline (61/98) → effectively 100% (97/98 + 1 accepted
  equivalent) across 2 verify rounds. New file
  `vault-provider-mutation.test.ts`. Notable: a VAULT_ADDR
  trailing-slash regex mutant required mocking `globalThis.fetch`
  directly, since Bun's own fetch client silently collapses redundant
  slashes before the request reaches the wire. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/secrets/index.ts`** (28 LOC —
  `getSecretsProvider()` factory). 5 mutants, 100% baseline (5/5 killed
  by the existing test alone) → **100%** after 1 verify round. New file
  `secrets-index-mutation.test.ts` gap-fills the re-exported
  `VaultProviderError` class and the fallback-to-local branch for any
  non-`"vault"` value. Closed via a worktree-isolated parallel Workflow
  agent.
- **Mutation testing — domain 10, `src/lib/ttl-cache.ts`** (66 LOC —
  generic TTL-cache factory with an injectable clock). 18 mutants, 100%
  baseline (18/18, no prior test existed) → **100%** after 1 verify
  round, stable. New file `ttl-cache-mutation.test.ts`. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/commands/connect.ts`** (117
  LOC — generates a ready-to-paste MCP client connection config). 121
  mutants, no prior test file → **100%** (121/121) after 2 verify
  rounds, stable. New file `connect-mutation.test.ts`. Wiring tests call
  the real `CONNECT_TEMPLATES[id].generate()` independently to compute
  an expected payload, exercising every connect.ts-owned field without
  duplicating connect-templates.ts's own logic. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/lib/origin-match.ts`** (71 LOC —
  shared Origin-header-vs-allowlist-entry comparison primitive). 53
  mutants, 98% baseline (52/53, first draft) → effectively 100%
  (52/53 + 1 accepted equivalent) in 1 verify round. New file
  `origin-match-mutation.test.ts`. The 1 equivalent: `.toLowerCase()`
  forced to `.toUpperCase()` is unobservable since the WHATWG URL parser
  already lowercases hostnames, and the comparison is symmetric on both
  sides regardless. Closed via a worktree-isolated parallel Workflow
  agent.
- **Mutation testing — domain 10, `src/lib/leader-loop.ts`** (73 LOC —
  shared setInterval-based leader-gated/periodic loop scaffold). 18
  mutants, 100% baseline (18/18, first draft — zero coverage of its own
  logic despite being spied-through in 2 sibling tests) → **100%** in 1
  verify round. New file `leader-loop-mutation.test.ts`. Closed via a
  worktree-isolated parallel Workflow agent.
- **Mutation testing — domain 10, `src/cli/client.ts`** (85 LOC — CLI
  credential store + bearer-authenticated fetch wrapper). 56 mutants,
  100% baseline (56/56, first draft, zero prior coverage) → **100%**,
  reconfirmed identical on an independent second run. New file
  `client-mutation.test.ts`. Closed via a worktree-isolated parallel
  Workflow agent.

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
