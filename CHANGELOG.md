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
  unanchored replace agree). Up from a 69.94% baseline. Suite grows 1608 →
  1627. Run with `STRYKER_TEST_SCOPE=src/proxy/__tests__ bun run test:mutate`.
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
  *generic* sensitive/`__confirm` gate via a single example tool; a sibling
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
  token with a stray *internal* space, since Node's own HTTP parser
  strips edge whitespace on the whole header value before the app ever
  sees it); a bundle/client name-collision confused-deputy gap in
  `mcpParamsForScope`; a client `.find()` "always match the first"
  direction masked by earlier tests' incidental registration order; the
  `Server`'s own self-identification (`getServerVersion()`, the SDK-side
  mirror of `mcp-upstream.ts`'s `getClientVersion()` technique); a
  `progressToken`-forced-true gap where the obvious fix (wait for a
  notification) was itself masked by schema validation dropping malformed
  notifications on *both* the real and mutant paths — the reliable signal
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
