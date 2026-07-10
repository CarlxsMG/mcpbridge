//
// Stryker mutation testing config — P2-3 expanded security scope.
//
// Uses the command test runner with coverage analysis OFF because the bun
// test runner doesn't emit a coverage report Stryker can parse natively.
// Without coverage analysis, every mutant triggers a full `bun run test`
// run, so the per-test-suite runtime dominates.
//
// SCOPE HISTORY:
//
//   P2-1  compare.ts only                 6 mutants   3m26s   66.67% (baseline)
//   P2-2  compare.ts only (with new tests) 6 mutants   3m29s  100.00% (closed)
//   P2-3a src/security/*.ts (12 files)   946 mutants  ABORTED @ 48.7%
//         461/946 tested, 140 survived -> ~284 projected. Too many to
//         kill in one commit; and with no incremental JSON a mid-run
//         abort yields ZERO data (the json/html reports only flush on
//         completion), so the 12-file / ~8h scope was over-sized.
//         Reverted to the P2-1/P2-2 incremental pattern below.
//   P2-3  4 small critical files          112 mutants  98.21% (110/112)
//         The 2 survivors are proven-equivalent mutants (unkillable), so the
//         effective score is 100% (110/110 non-equivalent killed): key-hash
//         L20 `length === 0` (redundant with `[].some() === false`) and
//         secret-box L35 `"utf8"` (Bun treats `""` as the utf8 default).
//         cookies.ts and system-role.ts both reached a clean 100%.
//   P2-4  bootstrap-admin + startup-guards  101 mutants  100.00% (101/101)
//         bootstrap-admin needed a logger SPY (spyOn) — 15 of its 16 survivors
//         were log() level/message/meta literals, killable only by asserting
//         the log call. startup-guards needed each reason chunk asserted + a
//         bare-string corsOrigins to hit the `[env.corsOrigins]` wrap.
//   P2-5  session-store + user-store        99 mutants  95.96% (95/99; 4 equiv)
//         Effective 100% — 4 proven-equivalent survivors: session-store L77
//         (safeCompare on a row fetched by that same hash is unreachable),
//         user-store L8 (typeof guard redundant with ADMIN_ROLES.includes), and
//         updateUser L111 `>=0`/`→true` (guarded by if(!existing), changes
//         always 1). First run scoped via STRYKER_TEST_SCOPE=src/security/
//         __tests__ (~24x faster: 3m28s vs ~84m; scoped-run commit 18052c4).
//   P2-6  jwt                              237 mutants  96.20% (228/237)
//         Densest file; 3 iterations (63.71→92.41→94.94→96.20). The 9
//         survivors are all equivalent/effectively-equivalent (atob padding,
//         OOB Uint8Array write, extractable flag, exp/nbf typeof guards, aud
//         [], default Date.now() clocks) — see jwt.test.ts header. Added RS256
//         coverage, nbf, exact reasons, aud-array, JWKS fetch/cache/timeout.
//         (concurrency raised 1→8 here — validated identical score on user-store.)
//   P2-7  mcp-key-store                    129 mutants  97.67% (126/129)
//         Effective 100% — 3 equivalent survivors, all redundant guards
//         (getMcpKey non-integer id, resolveMcpKeyByToken empty token,
//         hasAnyMcpKeys row!==null). ~1m20s at concurrency:8.
//   P2-8  oidc (last file)               262 mutants  94.66% (248/262)
//         Largest/most-complex file; 3 iterations (30.53→84.35→91.60→94.66).
//         14 equivalent/deep-infra survivors (nbf/aud like jwt, cleanup-masked
//         expiry, scope-split regex, identity-reuse guards, fetch/cache infra)
//         — see oidc.test.ts header. Covered discovery, token exchange, config
//         CRUD + validation, verifyIdToken claims, username derivation.
//   ── src/security/ series COMPLETE (P2-1..P2-8). ──
//
// DOMAIN 2 — src/proxy/ (scope STRYKER_TEST_SCOPE=src/proxy/__tests__):
//   PX-1  backends + transform + streaming  344 mutants  81.98% (282/344)
//         First pass (69.19→81.98). streaming 97%, transform 85%, backends 74%.
//         Remaining survivors concentrated in backends' wsRequest/Persistent
//         event-handler internals (error/close/settled paths) — a 2nd pass
//         with more WS-server variants is a follow-up.
//   PX-2  proxy.ts (dispatch core)         1146 mutants  93.72% (1074/1146)
//         raw / 94.76% incl. 12 genuine-infinite-loop timeouts Stryker itself
//         detects (recordSuccess/Failure loops, AbortSignal.any([]) emptied,
//         retry-backoff Math.pow misuse — real bugs a mutant would introduce).
//         13 new __tests__ files (one per functional cluster, C1-C13) covering
//         proxyToolCall's full dispatch pipeline: gates (enable/deleting/scope/
//         quota/sensitivity/quarantine/approval/guardrails/rate-limit), mock/
//         cache/coalesce, breaker/LB/canary routing, path/Ajv/transform, pinned-
//         IP + retry/backoff, success response + pagination integration, error/
//         retry exhaustion, WS dispatch, MCP dispatch. Two authoring rounds
//         (13 agents cold + 4 agents deepening the densest clusters) plus a
//         3rd round of 7 agents targeting the 60 remaining survivors by cluster
//         — verified 22 previously-surviving mutants now reliably killed
//         (parseRetryAfter HTTP-date boundary, cache-hit/mock recordUsage
//         payloads, canary/LB lookup guards, retry-loop HEAD/OPTIONS legs +
//         backoff formula, off-by-one retry boundary, 4 duration-metric units,
//         MCP mcpUrl/transport fallbacks) — but two independent full verify
//         runs (identical survivor sets both times, so NOT run-to-run noise)
//         show the SAME raw 60-survivor count: round 3 also newly exposed 22
//         different survivors it hadn't before. Spot-checked one (parseRetryAfter's
//         `!headerValue` early-return, L138): confirmed equivalent (a null
//         header still falls through parseInt/Date.parse's own NaN paths to
//         the same terminal `return null`) — most of the rest are presumed
//         similarly reclassified-equivalent or sandbox-timing artifacts in
//         real-wall-clock-based retry/backoff tests, not full regressions,
//         but a complete per-mutant triage of all 22 was not finished (time-
//         boxed). Net: genuinely stronger, more precisely-targeted coverage
//         and extensive newly-documented equivalence reasoning, at an
//         unchanged raw score — reported honestly rather than re-run further.
//   PX-3  backends.ts 2nd pass (wsRequest/wsRequestPersistent)  163 mutants
//         85.89% raw (140/163) / 96.93% incl. 18 genuine-hang timeouts (mutating
//         the `settled` once-only guard breaks a real WS exchange into a
//         double-resolve/hang, which Stryker correctly times out) — effectively
//         100%: all 5 raw survivors are documented-equivalent (`ws.send` cannot
//         throw synchronously in the `open` handler's real-Bun-runtime
//         invariant, and the `/^ws/` -> `/ws/` regex mutant is masked by the
//         adjacent URL-prefix guard one line earlier). Up from a 69.94%
//         baseline (74% per PX-1's estimate). Closes the WS event-handler gap
//         PX-1 flagged as a follow-up — `src/proxy/` domain now fully covered.
//   ── src/proxy/ domain COMPLETE (PX-1..PX-3). ──
//
// DOMAIN 3 — src/mcp/ (scope STRYKER_TEST_SCOPE=src/mcp/__tests__):
//   registry.ts (1318 LOC, the dynamic client/tool registry — 2nd-largest
//   backend file)  799 mutants  51.19% baseline (409/799) -> 98.25% raw
//   (785/799) / effectively 100% after 3 rounds. 10 new `registry-mutation-
//   rc1..rc10.test.ts` files, one per functional cluster: helpers/alias,
//   register(), registerMcp(), teardown/unregister/forgetClient/
//   reconcileFromDb, enable+guards setters, setToolOverride,
//   annotateToolDrift+applyGuardPolicy, resolveTool/effectiveAdvertised/
//   advertise methods, listClientsSummary/listAllTools, getClientDetail.
//   Round 1 (10 agents cold) drove 51.19% -> 94.12% (47 survivors); round 2
//   (5 agents extending the same files) drove 94.12% -> 98.25% (14
//   survivors, 6 of them independently re-verified equivalent by literally
//   hand-applying the exact mutation to registry.ts, re-running the suite,
//   confirming no failure, then reverting — not just reasoned about); a
//   final manual pass closed 5 more (a genuinely missed `retryNonSafeMethods`
//   default-parameter case, a `client_guards` DELETE the live-state-only
//   assertion couldn't observe, an error-message StringLiteral, a
//   truthy-non-string discriminator, and a `:param`-substitution-literal
//   case) leaving 9 documented-equivalent survivors, all structurally
//   unreachable via the public API (redundant guards one line later,
//   `resolveTool`'s cross-validation masking stale toolIndex entries,
//   registration's own upstream type guarantees). Effective score: 100%
//   (790/790 non-equivalent mutants killed). Not independently re-verified
//   via a 4th full Stryker run after the final manual pass (each fix was
//   instead verified via a standalone `bun -e` simulation proving the exact
//   divergence, plus direct test execution against the real, unmutated
//   source) — time-boxed given 3 already-run full verifies on this file.
//   registration.ts (667 LOC, discovery-to-registry glue: performRest/Mcp/
//   GraphqlRegistration, no prior unit-test file at all — only indirect
//   route-level coverage)  552 mutants  37.86% baseline (209/552) -> 99.09%
//   raw (547/552), effectively 100%. 6 new `registration-mutation-
//   rg1..rg5b.test.ts` files: shared helpers (module-load-only $ref
//   resolver + tools-count/endpoint-traversal checks), the REST path split
//   across 2 files (its validation gauntlet vs. tool-resolution+register,
//   since it's the single densest function), the MCP-upstream path, and the
//   GraphQL path split across 2 files (validation vs. discovery+register).
//   Round 1 (6 agents cold) drove 37.86% -> 97.64% (13 survivors); a final
//   manual pass closed 3 genuine gaps a round-1 prompt's line numbers had
//   missed (the discoverToolsFromGraphQl options object's ipPin/
//   includeMutations fields, and the success log call's exact args) leaving
//   5 documented-equivalent survivors — all inside resolveRefs's
//   module-load-only $ref resolver (which only ever runs once against the
//   fixed, valid, bundled openapi.yaml and is not exported, so no test can
//   supply a different input to observe a mutant there) plus one already-
//   proven-equivalent `pathname || "/graphql"` fallback (`new URL(...)
//   .pathname` is never falsy for any valid URL). Effective score: 100%
//   (547/547 non-equivalent mutants killed).
//   system-tools.ts (427 LOC, the /mcp root's sys_* control-plane catalog —
//   thin adapters + the two-axis authz model: role tier + sensitive/
//   __confirm step-up)  490 mutants  39.39% baseline (193/490) -> 99.80%
//   raw (489/490), effectively 100%. 5 new `system-tools-mutation-
//   st1..st5.test.ts` files: helpers+dispatch/auth (the security-critical
//   part — tier gating, sensitive step-up, envBearerOnly, catch-all error
//   handling), read-tier tools, operate-tier simple tools, sys_register_
//   client (densest single tool), admin-tier mint/revoke. Most of this
//   file's mutants sit in each tool's static inputSchema/description object
//   literals — closed in bulk by one exact toEqual per tool against a hand-
//   transcribed schema, rather than one test per literal. Round 1 (5 agents
//   cold) drove 39.39% -> 98.98%; a manual pass then found and fixed a
//   genuine coordination gap between two agents (ST1 tested runSystemTool's
//   GENERIC sensitive/__confirm gate via one example tool; ST5 assumed that
//   covered it, but each tool's OWN `sensitive: true` literal is an
//   independent AST node ST1 never actually exercised for sys_mint_key/
//   sys_revoke_key specifically — a real, if narrow, security-test gap, now
//   closed) plus a genuine agent mislabeling (a `str()`/`num()` non-string/
//   non-number pass-through bug an agent attributed to the wrong helper
//   function by line-number confusion) and one missed handler-logic test
//   (sys_list_keys). One final survivor (L74, num()'s forced-true
//   condition) is believed to be Stryker measurement noise rather than a
//   real gap — see [[px2_proxy_verification_noise]]-pattern: an
//   intermediate verify run confirmed it killed, a later one showed it
//   surviving again with zero test changes in between, and the relevant
//   test passes reliably (3/3) run directly. Not chased with a 4th full
//   verify given 3 already run on this file.
//   registry-persistence.ts (410 LOC, every SQLite interaction the
//   registry does — 3 row->DTO converters + RegistryPersistence's 3
//   methods)  113 mutants  82.30% baseline (93/113) -> **100.00% (113/113),
//   clean**. One new `registry-persistence-mutation.test.ts` file, authored
//   directly (no agent round needed — small enough for one pass) driving
//   the exported converters/class methods straight, bypassing the full
//   Registry/lock layer. 3 verify rounds: the first closed 18 of 20
//   baseline survivors (2 genuinely missed: a `cb_half_open_timeout_ms`
//   null-check twin to two already-covered siblings, and the `circuit
//   Breaker: {} -> undefined` empty-object collapse); the second closed
//   those 2 but exposed 2 DIFFERENT new ones (an empty-but-parsed `params:
//   {}` object not collapsing a tool-override row to `undefined`, and the
//   CLIENT-level `enabled` field on `buildPersistedClientFromDb`'s return,
//   distinct from the already-covered per-TOOL `enabled` field) — the same
//   kind of round-to-round non-equivalent-survivor swap seen on other files
//   in this series (see [[px2_proxy_verification_noise]]), not chased
//   further since both were genuine, closable gaps rather than noise; the
//   third verify came back perfectly clean.
//   transports.ts (358 LOC, the Streamable-HTTP transport layer: sharded
//   /mcp/:clientName, curated /mcp-custom/:bundleName, and the system-root
//   /mcp, all sharing handleStreamablePost/Get/Delete + a 60s TTL-eviction
//   timer)  286 mutants  48.25% baseline (138/286) -> 87.06%-87.76% raw
//   across 3 stable verify rounds (249-251/286, the range itself being this
//   file's own instance of the [[px2_proxy_verification_noise]] pattern —
//   net score stable, individual survivor IDs swap between otherwise-
//   identical runs) / effectively 100%: every raw survivor in the final
//   verify run is a documented-equivalent with concrete reasoning in one of
//   5 new `transports-mutation-t1..t5.test.ts` files (one per functional
//   cluster: helpers+TTL-cleanup-timer, handleStreamablePost's guard+reuse+
//   new-session path, its else-branch+catch-block, handleStreamableGet+
//   Delete, and setupTransports' route-wiring+graceful-shutdown), plus a
//   stable 13 genuine-timeout survivors (route-handler-body-emptied mutants
//   that correctly hang a real HTTP request against a real Express app,
//   the same "Stryker itself detects it via timeout" pattern documented for
//   PX-2/PX-3). Round 1 (5 agents cold, parallel Workflow) drove 48.25% ->
//   ~90.6% raw (27 survivors); a manual closing pass across 4 more verify
//   rounds fixed 5 genuine gaps the cold round's own equivalence reasoning
//   had gotten wrong or missed — most from one root cause the agents didn't
//   anticipate: `req.body` is `undefined` (not `{}`) when a request carries
//   no content-type at all, so `req.body?.id` vs `req.body.id` only
//   diverges on a BODYLESS request, not merely one missing an `id` key (5
//   OptionalChaining survivors across the POST scope-mismatch/maxSessions/
//   unknown-session/catch-block sites, all fixed the same way); a TTL
//   boundary `>` vs `>=` gap (fixed via `Date.now()` stubbing for an exact-
//   equality tick, avoiding real-clock flakiness); a mislabeled equivalence
//   note (T1 described `scopeKey`'s ternary RETURN-VALUE "system" literal
//   but cited the COMPARISON-TARGET literal's location — both are on the
//   same line and both are genuinely equivalent, just needed correcting to
//   the right column ranges); a missed `streamable.close()` mutant (map
//   entries are deleted regardless of whether `.close()` runs, so proving
//   it fires needs a REAL open SSE stream that must actually end — adapted
//   from T5's identical technique for the graceful-shutdown path); and a
//   second regex-anchor test (Stryker's regex mutator alternates between
//   dropping the leading `^` and the trailing `$` across runs — T1 only had
//   the `^` case covered). See transports-mutation-t1.test.ts's header for
//   the full isValidSessionId/scopeKey equivalence writeup and
//   transports-mutation-t2/t3.test.ts's headers for the
//   createMcpServer()/registry.getClient()-throw dependency-injection
//   technique used to reach handleStreamablePost's catch block at all (the
//   SDK absorbs every other failure mode internally and never rethrows).
//   mcp-upstream.ts (the outbound MCP upstream connection pool +
//   dispatcher: buildTransport, mcpResultToProxyResult, McpUpstreamPool's
//   call/listResources/readResource/listPrompts/getPrompt/ping/disconnect)
//   131 mutants  81.68% baseline (106/131) -> 96.18% raw (126/131) across
//   3 verify rounds (124->124->126, stable/improving, not chased with a
//   4th run) / effectively 100% (all 5 raw survivors documented-
//   equivalent). One new `mcp-upstream-mutation.test.ts` file, authored
//   directly (no agent round — small survivor count). The existing sibling
//   test file always injects a custom transportFactory, so `buildTransport`
//   itself (the real network-transport builder) was completely untested —
//   closed via direct calls plus reading the SDK's internal
//   `_requestInit`/`_fetch` fields off the constructed transport instance.
//   Also closed: a `connectTimeoutMs`/per-call-timeout family of gaps
//   (`??` vs `&&`, and 4 separate `{timeout: ...}` options objects on
//   connect/ping/readResource/getPrompt) via a reusable `delayMethod()`
//   helper that monkey-patches a real transport's `send()` to delay one
//   JSON-RPC method, proving a small custom timeout fires before a large
//   default would; a `getClient()` in-flight-connection-dedup gap (two
//   concurrent calls to the same unconnected upstream must share one
//   connect attempt, not race); and a `getPrompt()` catch-block gap.
//   5 documented equivalents, most with deeper structural reasoning than
//   usual: two `ListResourcesResultSchema`/`ListPromptsResultSchema`
//   `?? []` fallbacks are unreachable because the SDK's own zod schema
//   requires those array fields, so a malformed response throws before the
//   fallback line ever runs; a `Client` capabilities object literal is
//   subsumed by the SDK's own `?? {}` default; a `Buffer.byteLength(text,
//   "utf8")` -> `""` swap is the same encoding-equivalence already
//   documented for secret-box.ts; and 4 `if (x) opts.y = x` guards turned
//   out unobservable because the only inspection point (the constructed
//   transport's own field) reads `opts?.y` either way, and spying on the
//   SDK's transport CLASS exports to inspect the raw options object before
//   construction doesn't work — confirmed empirically that bun:test's
//   spyOn breaks `new` semantics on a class export.
//   mcp-server.ts (264 LOC, the security-critical core: createMcpServer()
//   builds a per-scope MCP Server binding tools/list + tools/call's full
//   authorization gate — system-role check, exact client-membership
//   confused-deputy defense, bundle-membership + composite-macro dispatch
//   — plus resources/prompts passthrough for a client-scoped MCP upstream)
//   181 mutants  61.33% baseline (111/181, ALL from indirect coverage via
//   transports.ts's own suite — this file had zero dedicated tests) ->
//   97.79% raw (177/181) across 5 verify rounds (171->173->174->176->177,
//   steadily improving, each round closing 1-3 genuine gaps rather than
//   plateauing) / effectively 100% (both remaining raw survivors
//   documented-equivalent). 5 new `mcp-server-mutation-s1..s5.test.ts`
//   files from a parallel Workflow cold round (61.33% -> 94.48%, 8
//   survivors), then a manual closing pass across 4 more verify rounds.
//   Key harness finding (discovered by the cold round, load-bearing for
//   every later fix): a lightweight InMemoryTransport Client<->Server
//   connection CANNOT carry `extra.requestInfo.headers` (the SDK's
//   InMemoryTransport only forwards `authInfo`, never `requestInfo`), so
//   anything reading a real Authorization/X-End-User-Id header value
//   needs a real-HTTP harness instead — but `setupTransports(app)` itself
//   cannot reach mcp-server.ts's OWN system-role gate in isolation, since
//   `rootMcpAuth` (mounted in front of `/mcp`) runs the identical
//   Bearer-extraction/resolveSystemRole check one layer up and rejects
//   first with a different message — so a bare `StreamableHTTPServerTransport`
//   wired directly to `createMcpServer({kind:"system"})`, deliberately
//   WITHOUT `rootMcpAuth`, was needed to isolate this file's own redundant
//   gate (see mcp-server-mutation-s2.test.ts's header). Genuine gaps
//   closed in the manual pass: a Bearer-prefix-bypass (crafting a non-
//   "Bearer "-prefixed header whose blind `.slice(7)` would have
//   accidentally landed on the real configured admin key); a SEPARATE
//   `.slice(7)` vs `.slice(7).trim()` mutant one column-range over
//   (needed a token with a stray internal space Node's own HTTP parser
//   doesn't strip, since edge whitespace on the whole header value IS
//   stripped before the app ever sees it — verified empirically); a
//   bundle/client NAME-COLLISION confused-deputy gap in
//   `mcpParamsForScope` (a bundle-scoped session must never resolve
//   through a same-NAMED client); a client `.find()` "always match the
//   first" direction masked by earlier tests' incidental registration
//   order (the wrong-but-first-registered client needs to ALSO be a live,
//   enabled MCP-kind one to be selectable at all); the Server's own
//   self-identification (`getServerVersion()`, the SDK-side mirror of
//   mcp-upstream.ts's `getClientVersion()` technique); a
//   `progressToken`-forced-true gap where the "obvious" fix (wait for a
//   notification to arrive) was itself masked by the SAME schema-
//   validation-drops-malformed-notifications behavior on BOTH the real
//   and mutant paths — the reliable signal turned out to be one layer
//   earlier (whether the SDK auto-generates an outbound progressToken at
//   all, observed directly on the fake upstream's own incoming request);
//   and a `scopedToolList` system-scope `?? []`-shaped no-credential
//   tools/list gap (same rootMcpAuth-bypass harness as the tools/call
//   gate). Final 2 raw survivors are both real, traced-not-assumed
//   equivalents: `isBundleEnabled`/`getBundleToolKeys`/`getBundleComposites`
//   all read the SAME `liveBundles` cache entry, so once `isBundleEnabled`
//   is true (a precondition — direct or via `||`/`if` short-circuit — of
//   every call site that consumes the other two), that entry is
//   GUARANTEED to already exist with real (possibly empty, but always
//   truthy) `Set` objects; the `?? []`/`?? false`/`?.` fallbacks for the
//   `| undefined` case Stryker mutates are dead code given how every
//   caller in this codebase is structured (see
//   mcp-server-mutation-s1.test.ts's header for the full 3-mutant writeup,
//   including why a hard `deleteBundle()` mid-session doesn't reach them
//   either — the outer gates independently reject for the same reason).
//   mcp-discovery.ts (117 LOC — MCP upstream tool discovery: name
//   normalization, collision de-dup, description fallback, paginated
//   tools/list connect flow)  53 mutants  77.36% baseline (41/53, from
//   mcp-upstream.test.ts's own "discovery" describe block, which only
//   exercised a two-way collision and a single-page response) -> 94.34%
//   raw (50/53) / effectively 100% (both raw survivors documented, plus
//   1 genuine-timeout survivor). One new `mcp-discovery-mutation.test.ts`
//   file, authored directly. Closed: a 3-way name-collision test (proving
//   the while-loop genuinely re-checks and increments past `_2`, not just
//   a single retry); a whitespace-only-description edge case (`"   "` is
//   truthy as a raw string but must still trigger the fallback once
//   trimmed); `getClientVersion()` for the CLIENT_NAME/CLIENT_VERSION
//   constants (same technique as mcp-upstream.ts); the `delayMethod()`
//   timeout-propagation technique applied to BOTH the connect phase and
//   each tools/list page (2 separate `{timeout}` object literals); and a
//   genuine multi-page pagination test (existing coverage never had a
//   `nextCursor`). One survivor (capabilities object literal) is the same
//   SDK-default-subsumes-it equivalence documented twice already this
//   domain. The other (collision-check's `.slice(0,63)` on the untruncated
//   candidate) was investigated in real depth: the only construction that
//   would distinguish it hits a PRE-EXISTING, mutant-independent infinite-
//   loop edge case in the real code first — not something to build test
//   infrastructure around; flagged as a latent out-of-scope limitation for
//   any future long-name hardening work.
//   tool-search.ts (110 LOC — the search_tools meta-tool: static schema
//   definition, pure ranking algorithm, runSearchTool dispatch) 90
//   mutants  80.00% baseline (72/90) -> 96.67% raw (87/90) across 3
//   verify rounds / effectively 100% (all 3 raw survivors documented
//   equivalent). One new `tool-search-mutation.test.ts` file, authored
//   directly — a pure, side-effect-free module tested purely via direct
//   function calls, no transport/harness needed at all. Closed: the
//   bulk-schema-toEqual technique for the static tool definition; a
//   description-fallback placeholder-string gap (a tool with NO
//   description at all must not accidentally match via an injected
//   Stryker placeholder); a per-token name-match gap whose "obvious" test
//   was itself accidentally satisfied by the SEPARATE whole-query-
//   substring boost (same code, different line) rather than the mechanism
//   under test — caught by checking the exact `score` value, not just
//   presence; a boost-vs-tie-break gap needing two tools engineered to an
//   EXACT equal per-token score, with only one alphabetically-later one
//   eligible for the boost, to prove the tie-break wouldn't otherwise flip
//   the winner; a punctuation-only-query gap (non-empty after trim, but
//   tokenizes to zero real tokens — the boost check isn't gated by token
//   count, so it can still wrongly fire); and query-coercion gaps for a
//   whitespace-only query and each non-number/non-finite `limit` shape.
//   All 3 equivalents trace to the SAME root cause: `.trim()` and
//   `tokenize()`'s `/[^a-z0-9]+/` split fully overlap on what counts as
//   whitespace/non-content for any realistic input, so "q empty but
//   tokens non-empty" (and vice versa) and "regex quantifier removed
//   before .filter(Boolean)" are all mathematically unreachable given how
//   the two operations are defined; a 3rd is `Number.isFinite()`'s own
//   spec-mandated non-coercion making a `typeof` pre-check redundant.
//   registry-alias-index.ts (96 LOC — RegistryAliasIndex, the display-name
//   alias map kept in lockstep with the registry)  28 mutants  **100.00%
//   (28/28) baseline, clean already** — the existing dedicated
//   registry-alias-index.test.ts already fully covered it; no new test
//   file needed at all.
//   tool-index.ts (78 LOC — ToolIndex, the canonical-key -> (client,tool)
//   lookup map)  16 mutants  **100.00% (16/16) baseline, clean already**
//   — the existing dedicated tool-index.test.ts already fully covered it;
//   no new test file needed. This was the LAST file in domain 3 —
//   ── src/mcp/ domain COMPLETE. ──
//
// DOMAIN 4 — src/db + src/middleware + src/net (core infra). Test dirs do
// NOT mirror source dirs 1:1 here (unlike domain 3) — confirmed
// src/net/ip-validator.ts's test lives in src/middleware/__tests__/, and
// there is no src/net/__tests__ at all. Scope:
// STRYKER_TEST_SCOPE="src/db/__tests__ src/middleware/__tests__"
// (space-separated, both dirs — verify per file which dir actually holds
// its test before assuming). src/db/migrations.ts (1024 LOC) evaluated
// and SKIPPED — an append-only array of static SQL template strings plus
// one small runMigrations() runner; almost entirely non-logic data, same
// reasoning as src/mcp/types.ts.
//   ip-validator.ts (283 LOC, src/net/ — the centralised SSRF/DNS-
//   rebinding defence: IPv4/IPv6 blocked-range checks, validateBackendUrl's
//   dual-stack DNS resolution, TTL re-pinning, pinned-fetch/pinned-lookup
//   transport helpers)  193 mutants  94.30% baseline (182/193, decent
//   existing IP-literal coverage, but zero real-DNS-path or
//   makePinnedFetch/makePinnedLookup coverage) -> 99.48% raw (192/193)
//   across 2 verify rounds / effectively 100% (the one raw survivor is a
//   genuine equivalent). One new `ip-validator-mutation.test.ts` file,
//   authored directly. New technique for this file: `Bun.dns.lookup` is a
//   real global `spyOn` can mock directly
//   (`spyOn(Bun.dns, "lookup").mockImplementation(...)`), letting
//   validateBackendUrl's dual-stack DNS branch be driven deterministically
//   per-family (success/reject) with zero real network access — reusable
//   for any future file that calls Bun.dns.lookup directly. Closed: a
//   6to4-false-positive gap (a PUBLIC IPv6 address whose bit pattern would
//   decode to a private IPv4 if the 6to4 extractor were wrongly applied to
//   it); isRawIpLiteral's exported behavior directly; the IP-literal fast
//   path's actual skip-DNS-entirely guarantee (proven via the dns spy
//   asserting zero calls, not just the right answer); the v4/v6-partial-
//   failure fallback arrays (a poisoned fallback masquerading as a real
//   DNS record would crash downstream on `.address` of a bare string);
//   both directions of the all-records-empty check; allowPrivateIps
//   actually gating the private-range rejection (tested both ways); the
//   IPv4-preference tie-break when both families resolve; a malformed-URL
//   catch path; non-http(s) protocol rejection; a bracketed-IPv6 URL
//   through the FULL validateBackendUrl path (not just isRawIpLiteral in
//   isolation); refreshPinIfStale's thrown-message reason-vs-hostname
//   distinction (the existing sibling test's regex assertion matched the
//   message's STATIC prefix text regardless of the mutation, masking the
//   gap — fixed by using a hostname textually distinct from the resolved
//   blocked IP so the two interpolation candidates are unambiguous); and
//   makePinnedLookup, previously untested at all. 2 documented equivalents
//   (an unreachable defensive catch given ipaddr.js's own guarantees after
//   a successful parse; a `||`-vs-`&&` pair only distinguishable by
//   hostname shapes the WHATWG URL parser never actually produces) plus a
//   3rd found on verify2 (`.toString()` on an already-string input is a
//   no-op, and a URL-object input already takes the same branch in both
//   real and mutant code, since `typeof` on an object is never "string").
//   auth.ts (207 LOC, src/middleware/ — admin auth (Bearer OR session+CSRF),
//   MCP data-plane auth (env keys / DB-managed keys / JWT / "no auth
//   material => allow all" fallback), and the /mcp control-plane's fail-
//   closed rootMcpAuth)  152 mutants  94.08% baseline (143/152, ALL
//   indirect — no dedicated test file existed at all; real coverage for
//   rootMcpAuth in particular lives in src/mcp/__tests__/transports*.test.ts,
//   OUTSIDE this domain's STRYKER_TEST_SCOPE) -> 100% effective (151/152
//   killed, 1 stable Timeout on the same `adminAuth`-body-emptied
//   BlockStatement pattern seen on transports.ts/mcp-server.ts — accepted
//   per this program's established "genuine Stryker timeout = detected"
//   convention, not chased further). One new `auth-mutation.test.ts` file,
//   authored directly (small enough for one pass, no agent round needed).
//   Rather than widen STRYKER_TEST_SCOPE to include src/mcp/__tests__
//   (slower, permanent cross-domain coupling), made this file's own
//   coverage self-sufficient: every branch driven directly via lightweight
//   mock Express req/res objects (same idiom as
//   origin-validator-envelope.test.ts) plus `spyOn` on system-role.js/
//   jwt.js/mcp-key-store.js/session-store.js/user-store.js. 4 verify
//   rounds (baseline -> 1 survivor+1 timeout -> 3 survivors+timeout -> 5
//   DIFFERENT survivors, 0 timeout -> clean but for the 1 stable timeout);
//   round 3's survivor-set change vs round 2 was a genuine consequence of
//   the fixes just applied shifting which branches got freshly exercised,
//   not [[px2_proxy_verification_noise]]-style flakiness. Genuine gaps
//   closed across the rounds: rootMcpAuth's 3 outcomes (missing header,
//   present-but-rejected token with the exact message, resolved role);
//   evaluateMcpAuth's JWT branch (isJwtConfigured forced-true only
//   detectable with hasAnyMcpKeys=true so the unrelated "no auth material"
//   fallback doesn't short-circuit first and mask it); the `if (token)`
//   guard (resolveMcpKeyByToken must never even be called with no header);
//   an env-key-match exact-object assertion; the env-configured-but-non-
//   matching-token case (an `&&`-vs-`||` gap: merely HAVING env keys
//   configured must not itself grant access to a token that doesn't match
//   any of them); the "no auth material" fallback both ways; the
//   `config.authDisabled` early-return in evaluateMcpAuth (needed
//   mcpApiKeys non-empty so the real fallthrough would otherwise land on
//   401, isolating this one line from the same fallback); mcpAuth's
//   mcpKeyId/jwtSubject request-mutation guards (the jwtSubject one needed
//   `hasOwnProperty` rather than an equality check, since the mutant
//   assigns literal `undefined` rather than skipping the assignment
//   entirely — an equality check can't tell the two apart); mcpAuth's
//   rejected-verdict short-circuit (a `sendError(...); return;` block
//   emptied would otherwise silently call next() anyway); and adminAuth's
//   session-path optional chaining on `findUserById(session.userId)?.teamId`
//   (a deleted/missing user must resolve teamId to null, not throw a
//   TypeError — required mocking validateSession+findUserById directly and
//   using a safe GET method to isolate this line from the CSRF branch).
//   circuit-breaker.ts (214 LOC, src/middleware/ — CircuitBreaker's
//   closed/open/half_open state machine + its module-level singleton
//   registry: getCircuitBreaker/updateCircuitBreakerConfig/
//   getAllCircuitStates/getAllBreakerStateGauges/removeCircuitBreaker/
//   startCircuitBreakerCleanup)  132 mutants  93.18% baseline (123/132,
//   the class's own state-machine logic was already thoroughly covered by
//   the existing circuit-breaker.test.ts — every survivor was in a
//   module-level function or a metric/log side effect that test file never
//   touched) -> **100.00% (132/132), clean** across 5 verify rounds
//   (128->128->131->131->132 — 4 consecutive rounds each surfacing a
//   DIFFERENT non-overlapping survivor set at the same net-131/132 score
//   before the final clean run, this file's own instance of
//   [[px2_proxy_verification_noise]]; each new survivor was investigated
//   and confirmed a genuine, closable gap rather than assumed noise, per
//   the registry-persistence.ts precedent). One new
//   `circuit-breaker-mutation.test.ts` file, authored directly. Closed:
//   three breakerStateTransitions metric-label assertions (half_open-
//   >closed, half_open->open, closed->open) verified via the Counter's
//   own `.render()` output rather than a spy
//   (`expect(breakerStateTransitions.render()).toContain('client="x",
//   from_state="a",to_state="b"')`) — a new, simpler alternative to
//   spying when a metrics primitive already exposes a readable dump; two
//   log() call-content assertions (half_open->closed/half_open->open) via
//   the established `spyOn(logger, "log")` technique; the thundering-herd
//   probe rejection's exact `reason: "Probing"` string (existing tests
//   only checked the `allowed` boolean); the BREAKER_IDLE_TTL constant's
//   `5 * 60_000` value, unexported but observed indirectly by spying
//   `startPeriodicSweep` (from `lib/leader-loop.js`) to capture the real
//   intervalMs argument passed at call time; updateCircuitBreakerConfig's
//   `?.` no-op-on-missing-client guard AND (found only on verify4) that it
//   actually applies to an EXISTING breaker — the original test only
//   proved the no-op half; getAllCircuitStates/getAllBreakerStateGauges/
//   removeCircuitBreaker, none of which had ANY prior test touching them
//   at all; getState's `>=` (not `>`) resetTimeoutMs boundary tick, and
//   the sliding-window prune's `<` (not `<=`) windowMs age-out boundary —
//   both needed exact `Date.now()` stubbing to the boundary value itself
//   (captured via the internal timestamp actually used, not an
//   approximated wall-clock offset) to avoid a few-ms race.
//   rate-limiter.ts (267 LOC, src/middleware/ — the sliding-window rate
//   limiter: 6 tiers (global/mcp/register/tool/login/install_link), LRU-
//   bounded bucket maps, and the idle-bucket eviction sweep)  164 mutants
//   90.85% baseline (149/164 — checkRateLimit/checkLimit and the LRU
//   primitives were thoroughly covered by 3 existing test files, but the
//   Express-wrapped middleware factories and the eviction sweep had never
//   been driven directly) -> **100.00% (164/164), clean** across 7 verify
//   rounds (155->162->163->163->162->161->164 — a longer tail than
//   circuit-breaker.ts's, following the SAME [[px2_proxy_verification_noise]]
//   pattern of each round surfacing a different, non-overlapping tier's
//   equivalent gap rather than plateauing on one). One new
//   `rate-limiter-mutation.test.ts` file, authored directly. Key findings:
//   - **The `lruSet` eviction log is SAMPLED (`Math.random() < 0.01`), not
//     unconditional** — needed `spyOn(Math, "random")` to deterministically
//     force both the "not sampled" (must NOT log) and "sampled" (must log
//     the exact level/message/meta) branches; an unconditional-log test
//     would have missed the ConditionalExpression-forced-true mutant.
//   - **`retryAfterSeconds > 0` doesn't distinguish `-` from `+`** on
//     `oldestInWindow + WINDOW_MS - now` — a `+`-flipped mutant still
//     produces a large POSITIVE number, so only an exact expected value
//     (computed by hand from controlled `Date.now()` inputs) catches it.
//   - **Six near-identical middleware factories (rateLimitRegister/Login/
//     InstallLink/Mcp/Global) each needed their OWN dedicated tier-string
//     assertion** via `rateLimitHits.render()` — a shared helper pattern
//     doesn't eliminate the need for one assertion per call site, since
//     each factory's `"tier"` argument is an independent AST literal.
//   - **`req.ip ?? req.socket?.remoteAddress` only diverges from a `&&`
//     mutant when `req.ip` is TRUTHY** — both operators short-circuit
//     identically when the left side is falsy/nullish, so a "both absent"
//     no-throw test (which kills the adjacent OptionalChaining mutant)
//     does NOT kill the LogicalOperator mutant. Needed a truthy `req.ip`
//     paired with a DIFFERENT `req.socket.remoteAddress` value and an
//     assertion on which one actually became the bucket key — present in
//     both rateLimitInstallLink and rateLimitMcp's identical fallback.
//   - **A single-request happy-path test can't distinguish a real string
//     key from a mutated one** — `const key = "global"` collapsed to `""`
//     still produces `next()` called / no 429 on the very first call
//     either way; needed a direct `globalBuckets.has("global")` /
//     `.has("")` check.
//   - **evictEmpty had ZERO coverage at baseline** (its whole body was an
//     unreached survivor) — closed via the SAME `spyOn(leaderLoopMod,
//     "startPeriodicSweep")`-captures-the-callback technique introduced
//     for circuit-breaker.ts, seeding all SIX tier maps at once with a
//     token exactly `WINDOW_MS` old (must prune to empty and evict) and a
//     fresh token (must survive), which also kills the `<`/`<=` boundary
//     and `=== 0`/`!== 0` pair in one shot.
//   1 documented equivalent: 97:24-97:26 ArrayDeclaration (an injected
//   `["Stryker was here"]` on a freshly-created bucket) — verified
//   empirically (`bun -e`) that the very next line's prune filter always
//   strips it (`now - "Stryker was here"` is `NaN`, and `NaN < WINDOW_MS`
//   is always `false`), so the junk entry is unobservable via any call path.
//   ── DOMAIN 4 sizeable files COMPLETE (ip-validator.ts, auth.ts,
//   circuit-breaker.ts, rate-limiter.ts). ──
//   8 small remaining files (request-id.ts, origin-validator.ts,
//   connection.ts, json-depth.ts, authz.ts, leader-lease.ts,
//   rate-counters.ts, cors.ts — all <100 LOC, 295 mutants combined),
//   batched into ONE Stryker run rather than one-file-at-a-time.
//   95.25% baseline (278/295 raw + 3 accepted timeouts) -> effectively
//   100% across 5 verify rounds. 6 new test files (no agent round —
//   small enough for direct authoring): origin-validator-mutation,
//   json-depth-mutation, authz-mutation, leader-lease-mutation,
//   rate-counters-mutation, cors-mutation. connection.ts was already
//   100% clean at baseline. Accepted timeouts: request-id.ts (2, its
//   whole middleware body + the withTraceContext callback), json-depth.ts
//   (1, exceedsDepth's whole body), cors.ts (1, corsMiddleware's whole
//   body past the Origin-present branch) — all the same route-handler-
//   body-emptied pattern used throughout this program. Key findings:
//   - **A duplicated test-only reimplementation can hide that the REAL
//     function is untested.** origin-validator.test.ts tests its own
//     hand-copied `matchOrigin`, never the real `isOriginAllowed`/
//     `matchesOriginEntry` — so the real port-wildcard option
//     (`{ supportsPortWildcard: true }`) being silently dropped went
//     undetected. Always check whether a "covers this logic" test file
//     actually imports the real exported function.
//   - **`typeof null === "object"` in JS** — a naive `&&`-flip on
//     `root === null || typeof root !== "object"` looks equivalent for
//     every primitive (they all funnel through `Object.values()` to the
//     same final answer) EXCEPT `null` itself, where the flip skips the
//     short-circuit and `Object.values(null)` throws. Verified the
//     REMAINING sub-mutant (the `typeof` check alone, forced false) IS
//     equivalent precisely because the one input that would diverge
//     (`undefined` as root) can never reach this function at all — the
//     middleware wrapper filters it one layer up, and it can never
//     appear as a recursive child either (the same child-type check that
//     filters primitives also excludes it).
//   - **An unexported counter observable only via a modulo check can make
//     `++`/`--` a genuine equivalent pair** — `rate-counters.ts`'s
//     `opCount` has no getter, and any 200 consecutive integers (counted
//     up OR down) contain exactly one multiple of 200, so the prune
//     fires with identical frequency regardless of direction. Confirmed
//     via a `bun -e` simulation across multiple arbitrary starting
//     offsets before accepting, not just reasoned about.
//   - **`cors.ts`'s wildcard fast-path accumulated 4 equivalent variants
//     across verify rounds** (ConditionalExpression and StringLiteral
//     mutants on `origins[0] === "*"`, `origins.length === 0`, and
//     `if (isWildcard)` one level up) — all structurally redundant with
//     `matchesOriginEntry`'s own unconditional `entry === "*"` match plus
//     a SEPARATE, independently-computed `isWildcard` flag downstream
//     that reads the identical config value. Once one variant in a
//     cluster is proven equivalent, expect siblings on the same
//     underlying check to keep resurfacing across rounds — re-verify
//     each with the same empirical technique rather than assuming.
//   ── DOMAIN 4 (src/db + src/middleware + src/net) COMPLETE. ──
//
// DOMAIN 5 — src/tool-policies + src/tool-meta + src/content-filtering +
// src/backend-auth (16 files, ~2311 LOC). Test dirs mirror source dirs
// 1:1 (src/tool-policies/__tests__, src/tool-meta/__tests__,
// src/content-filtering/__tests__), EXCEPT backend-auth's two files
// (oauth.ts, upstream-auth.ts), whose tests live at
// src/security/__tests__/oauth.test.ts and upstream-auth.test.ts — a
// leftover from before those source files moved out of src/security/
// (see [[backend_structure_audit]]). Scope per file/batch accordingly.
//   context-budget.ts (368 LOC, the largest file in this domain — per-tool
//   "context budget" guardrail: deterministic byte truncation + opt-in
//   LLM summarization via admin-configured OpenAI/Anthropic-compatible
//   endpoints, with any LLM failure falling back to truncation)  197
//   mutants  69.5% baseline (137/197, decent existing coverage of the
//   happy paths but the LLM request-shape/error-handling internals were
//   thin) -> 97.97% raw (193/197) across 2 verify rounds / effectively
//   100% (the 4 remaining are 1 documented equivalent + 3 accepted
//   timeouts). Given the LARGE survivor count (57 across 7 distinct
//   functional clusters — comparable in scale to registry.ts/proxy.ts),
//   used a 7-agent parallel Workflow (one agent per cluster, each writing
//   its own `context-budget-mutation-cb1..cb7.test.ts`), followed by one
//   manual closing pass (`cb8.test.ts`) for gaps the cold round missed.
//   Scope: STRYKER_TEST_SCOPE="src/tool-policies/__tests__".
//   Key findings:
//   - **A leaked, unrestored `spyOn` on a shared logger export breaks
//     UNRELATED sibling test files, not just later tests in the same
//     file.** One agent's cluster (callAnthropic) called
//     `spyOn(loggerMod, "log")` six times across six tests but never
//     `.mockRestore()`'d any of them — since ES module exports are
//     singletons, this permanently left `logger.log` mocked for every
//     test file that ran afterward in the same process (`bun test` runs
//     all files in one process). The symptom was bizarre and easy to
//     misdiagnose: a LATER, unrelated cluster's test expecting exactly 1
//     logged call instead saw 418 (every migration-log and registry-event
//     call from every file executed since the leak, funneled through the
//     same never-restored mock). Always pair every `spyOn` with a
//     `finally { spy.mockRestore(); }` — a bare `mockClear()` between
//     tests in the SAME file (which the leaking agent used, believing it
//     was sufficient) does not prevent the leak from crossing file
//     boundaries.
//   - **A ConditionalExpression forced-true on one half of an `&&` can be
//     unreachable via the norm write path but still a real gap** — both
//     `cfg.mode === "llm_summarize" && cfg.llm` (only reachable with a
//     "llm_summarize"-mode row with null llm fields) and its mirror image
//     (a "truncate"-mode row with llm fields populated) needed the same
//     schema-permits-it-but-the-app-never-writes-it direct-INSERT
//     technique already established for domain-3's registry.ts-adjacent
//     work — the `tool_context_budget` table's CHECK constraint only
//     validates `mode`'s enum values, never mode/llm-column consistency.
//   - **`end > 0` vs `end >= 0` on a UTF-8 boundary-backoff loop is a
//     genuine equivalent**, verified empirically across 9 cases (ASCII,
//     multi-byte, zero-maxBytes, all-multi-byte-backing-off-to-zero):
//     `end` only ever reaches exactly 0 via either `maxBytes <= 0` (loop
//     never runs, real code) or every boundary from the initial `end`
//     down to 1 throwing (loop exits via the false condition either way).
//     The mutant's one extra `end === 0` iteration decodes a zero-length
//     slice, which always succeeds and always returns `""` — a genuine
//     no-op either way.
//   - **The Workflow's own cost**: 757k subagent tokens / 134 tool calls
//     across 7 agents (~8 minutes wall-clock, parallel) to go from 69.5%
//     to 97.97%, then one manual pass to close the last 6 real gaps the
//     cold round missed (all traceable to specific per-agent oversights:
//     request method/Content-Type never asserted, the test-only fetch
//     reset helper's own body never exercised, and the truncate-mode
//     mirror of the llm-mismatch case). Consistent with domain 3's
//     registry.ts/proxy.ts experience: a cold parallel round gets most of
//     the way there fast, but always budget a manual closing pass.
//   load-balancer.ts (313 LOC, src/tool-policies/ — per-client N-way
//   upstream load balancing: round-robin/weighted/least-conn strategies,
//   SSRF-validated + IP-pinned target pool CRUD, per-target health
//   cooldown independent of the client-level circuit breaker)  234
//   mutants  81.62% baseline (191/234, decent existing coverage of the
//   3 strategies' happy paths, but validation boundaries and the DI
//   test helpers themselves were thin) -> 98.29% raw (230/234) across 3
//   verify rounds / effectively 100% (all 4 raw survivors documented
//   equivalents). Test dir is CROSS-DIRECTORY: the dedicated test file
//   lives at `src/mcp/__tests__/load-balancer.test.ts`, not
//   `src/tool-policies/__tests__/` (same gotcha class as auth.ts's
//   rootMcpAuth in domain 4) — scope
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__ src/mcp/__tests__"`.
//   Given a SMALLER, more mechanical survivor count than
//   context-budget.ts (43 vs. 57, mostly validation-boundary
//   boilerplate), authored directly rather than via a Workflow — one new
//   `load-balancer-mutation.test.ts`. Key findings:
//   - **Module-level `let x = () => ...` DI-helper initial values are
//     genuinely unreachable once ANY test file establishes a resetting
//     `beforeEach`.** Both `nowFn`'s and `randFn`'s initial declarations
//     (`let nowFn = () => Date.now()`) are distinct AST nodes from the
//     structurally-identical reassignment inside `__resetLbForTesting`
//     — but since `bun test` runs every file in one process and this
//     module's OWN test file (correctly) resets both in every
//     `beforeEach`, the initial declarations are overwritten before the
//     first assertion of the first test ever runs. A NEW equivalence
//     class worth checking on any future `let fn = () => ...` module
//     global with its own test-only reset helper.
//   - **A `>0`/`>=0` fallback-to-full-set boundary needs the EXACT zero
//     case, not just "some unhealthy."** `healthy.length > 0 ? healthy :
//     members` — cooling down only SOME targets never reaches the
//     boundary; needed every single member (including primary) cooling
//     simultaneously, and asserting the call doesn't throw (the `>=0`
//     mutant selects from the empty `healthy` array, and `pool.length`
//     of 0 makes round-robin's `idx % pool.length` a `% 0` — `NaN` —
//     indexing `pool[NaN]` to `undefined`, then `.choice` throws).
//   - **A boundary hit at a NON-LAST loop iteration is required to
//     distinguish `<` from `<=` in an early-return accumulator loop** —
//     `for (const m of pool) { r -= m.weight; if (r < 0) return
//     m.choice; }`. A test where the boundary coincidentally lands on
//     the LAST member (as an earlier "does the fallback throw" test
//     did) can't tell `<` from `<=`, since both take the same return
//     path there — needed r to hit exactly 0 after subtracting a
//     NON-last member's weight specifically.
//   - **An arithmetic `-1`-to-`+1` flip needs a THIRD reference point,
//     not just "did the count change."** A "stays tracked, not wiped"
//     test (checking presence/absence) doesn't prove SUBTRACTION
//     specifically — `+1` also changes the tracked value, just upward
//     instead of downward. Needed a comparison against a fixed
//     third-party count (an untouched primary) positioned so the real
//     (decremented) and mutant (incremented) values land on OPPOSITE
//     sides of it, flipping which member a `least-conn`-style
//     comparison would pick.
//   quarantine.ts (253 LOC, src/tool-policies/ — auto-quarantine after N
//   consecutive content-guardrail hits: block/force_approval/observe
//   actions, auto (cooldown) vs manual recovery)  102 mutants  85.3%
//   baseline (87/102, decent existing coverage of policy CRUD/escalation/
//   the 3 actions/basic recovery, but zero coverage of
//   getQuarantineForClient and thin coverage of the cooldown-computation
//   boundary combinations) -> 99.02% raw (101/102) across 2 verify rounds
//   / effectively 100% (the 1 raw survivor is the SAME `let fn = () =>
//   ...` DI-helper-initial-value equivalence class discovered on
//   load-balancer.ts — `nowFn`'s module-load-time closure, unreachable
//   once this file's own `beforeEach`/`afterEach` unconditionally call
//   `__setClockForTesting(null)`). One new `quarantine-mutation.test.ts`,
//   authored directly (15 baseline survivors, small enough for one
//   pass). Key findings:
//   - **A "no policy configured" test can't prove an early-return guard
//     is load-bearing if the FOLLOW-ON logic reaches the identical
//     conclusion anyway.** `checkQuarantine`'s `if (!policy) return
//     {active:false}` forced-false mutant still produces `{active:
//     false}` for a genuinely-empty client, since the downstream `if
//     (!state.quarantined)` check ALSO returns `{active:false}` for a
//     tool with no accumulated state. Needed an ORPHANED state row
//     (`quarantined=1` with NO policy — a shape the public API can
//     never itself produce, since clearing a policy deletes both rows
//     together) constructed via direct INSERT to prove the early return
//     fires BEFORE state is ever consulted.
//   - **The SAME DB-mismatch technique closed a 3-mutant cluster on a
//     compound `&&` condition**: `policy.recoveryMode === "auto" &&
//     state.cooldownUntil !== null && nowFn() >= state.cooldownUntil`.
//     Manual mode never itself produces a non-null `cooldownUntil`, so
//     proving the `recoveryMode === "auto"` check is genuinely
//     load-bearing (not just vacuously true whenever the other two
//     conditions matter) needed a manual-mode policy with cooldown_until
//     forced into the past via a direct UPDATE — confirming quarantine
//     stays active despite an "expired" cooldown that should never even
//     be consulted in manual mode.
//   - **`x >= null` coerces to `x >= 0` in JS — always true for any
//     realistic timestamp**, making a `!== null` guard's forced-true
//     mutant a real, exploitable gap: auto mode with a genuinely-null
//     cooldownUntil (cooldownMs never configured) would auto-clear
//     IMMEDIATELY under the mutant, rather than never auto-clearing as
//     intended. Worth checking for on any future `x !== null && y >=
//     x`-shaped guard.
//   guardrails.ts (195 LOC, src/tool-policies/ — content guardrails: input
//   deny-pattern/secret-shape blocking, output prompt-injection scanning)
//   189 mutants  51.85% baseline (98/189, by FAR the lowest baseline this
//   whole program has seen — driven almost entirely by Stryker's regex
//   mutator generating ~5-8 boundary variants EACH across 7 SECRET_PATTERNS
//   and 10 INJECTION_PATTERNS regex literals) -> 99.47% raw (188/189)
//   across 2 verify rounds / effectively 100% (the 1 remaining raw
//   survivor is a documented equivalent). Given the scale (91 survivors,
//   comparable to context-budget.ts's 57), used a 4-agent parallel
//   Workflow split by functional area — secrets, injection patterns,
//   compile-cache+row-collapse+client-aggregation, setGuardrails+input-
//   gate — followed by one manual closing pass (4 real gaps the cold
//   round's tests didn't quite distinguish). Scope:
//   STRYKER_TEST_SCOPE="src/tool-policies/__tests__". Key findings:
//   - **Regex boundary mutants split into TWO distinct testing
//     techniques, and conflating them wastes effort.** Character-class
//     negation (`[A-Za-z0-9]` -> `[^A-Za-z0-9]`) and whitespace-charclass
//     flips (`\s+` -> `\S+`) are killed by an ordinary REALISTIC positive
//     match (a real secret/injection phrase already uses the "right side"
//     of the negation). But QUANTIFIER-REDUCTION mutants (`{16}` -> `{1}`,
//     `{8,}` -> no quantifier, `\s+` -> `\s` exactly-one) need the OPPOSITE:
//     a NEGATIVE near-miss test proving the ORIGINAL (larger) minimum is
//     genuinely enforced — a string satisfying the mutant's weaker
//     requirement but NOT the real one. For length quantifiers, the
//     reliable construction is exactly ONE valid character in the
//     quantified run immediately followed by a delimiter (space, `.`, end
//     of string) — verified empirically before committing to it, since a
//     naive "one full character short" approach can accidentally also fail
//     to match under the MUTANT too (e.g. via an unrelated `\b` boundary
//     landing wrong), producing a false sense of a killing test. For `\s+`
//     patterns, a DOUBLED whitespace character between the relevant words
//     serves the same role (matches real `\s+`, fails a reduced-to-exactly-
//     one mutant).
//   - **A cache-hit code path's own `?? null` normalization can make an
//     upstream catch-block's specific null-assignment fully equivalent.**
//     `compileDenyPattern`'s catch (`compiled = null`) emptied leaves
//     `compiled` as `undefined` instead — but BOTH the immediate
//     `if (re && ...)` consumer AND the cache's own read-side `?? null`
//     fallback treat `undefined`/`null` identically, so no exported
//     function can ever observe the difference. Confirmed via a
//     standalone `bun -e` trace of both branches before accepting.
//   - **A regex-argument coercion quirk turned a seemingly-redundant
//     "does it throw" test into a genuine miss.** `RegExp.prototype.test`
//     coerces its argument via `ToString`, so an EMPTIED catch block
//     leaving a variable at JS `undefined` (not a compile error, since TS's
//     static "definitely assigned" check doesn't model try/catch-with-a-
//     throwing-assignment) gets silently stringified to the literal text
//     `"undefined"` at the call site — neither throwing NOR producing an
//     obviously-wrong result for an arbitrary deny pattern. The
//     distinguishing test needed a deny pattern that specifically targets
//     the WORD "undefined", not just any pattern plus a circular-reference
//     input.
//   - **A "does getGuardrails return null" test can't distinguish a real
//     DELETE from a fallen-through upsert with all-empty values**, because
//     `rowToGuardrails`'s OWN "nothing enabled" collapse-to-null logic
//     (a SEPARATE, already-tested check) re-derives `null` from an
//     all-empty row read back just as readily as from a genuinely absent
//     row. Needed a raw `SELECT COUNT(*)` against the table directly to
//     prove zero rows remain — the same "public-API return value alone
//     isn't enough, inspect the raw DB state" lesson as quarantine.ts's
//     orphaned-state-row technique, applied in the opposite direction
//     (proving absence rather than proving an orphan's presence).
//   - **A method-chain-collapse mutant can drop just the LAST call in a
//     chain, not the whole chain** — `.map(...).filter(...).slice(...)`
//     losing only `.slice(0, MAX_DENY_PATTERNS)` still passes any test
//     that never supplies MORE than the cap's worth of input. When a
//     pipeline ends in a bounding/capping operation, always test the
//     over-the-cap case explicitly, not just the transform/filter steps.
//   pagination.ts (159 LOC, src/tool-policies/ — cursor/page/link-header
//   pagination strategies: getPaginationConfig/setPaginationConfig,
//   getByPath, parseNextLink's RFC-5988 Link-header regex, withItems'
//   nested-path response rewrite)  114 mutants  75.44% baseline
//   (86/114, decent existing end-to-end coverage of the 3 strategies via
//   proxyToolCall, but the config enabled/pageParam round-trip
//   boundaries, getByPath's null-intermediate guard, parseNextLink's
//   regex whitespace/quote boundaries + malformed-segment `continue`,
//   and withItems' null/non-object/nested-descent guards were all
//   thin) -> **100.00% (114/114), clean** in a single verify round. One
//   new `pagination-mutation.test.ts`, authored directly (29 baseline
//   survivors, well under the multi-agent Workflow threshold). Closed:
//   the `enabled`/`pageParam` `??`->`&&` read/write round-trip pair (a
//   truthy pageParam persisted and read back proves both directions at
//   once); getByPath's `cur === null` guard isolated from its sibling
//   `typeof` check via an explicit null intermediate; 3 distinct
//   parseNextLink regex-boundary clusters (whitespace before/after the
//   `;rel=` separator, spacing around `rel = "next"`, and optional-quote
//   removal on an unquoted `rel=next` value) plus a `.trim()` gap on the
//   captured URL and the malformed-segment `if (!m) continue` guard
//   (proven via a garbage segment ahead of a valid one); and withItems'
//   whole-body and per-intermediate-segment null/non-object guards plus
//   the nested-descent loop's condition/direction/body (needing a
//   multi-segment itemsPath with an untouched sibling property, since
//   the existing test only ever exercised a single segment). No new
//   equivalence classes this file — every survivor was a genuine,
//   closable gap. Run with `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`.
//   response-cache.ts (159 LOC, src/tool-policies/ — the per-tool GET
//   response cache: durable tool_cache config + a process-local TTL+LRU
//   in-memory store)  83 mutants  77.11% baseline (64/83, the existing
//   response-cache.test.ts — cross-directory, at
//   src/proxy/__tests__/response-cache.test.ts — fully covers config
//   persistence and the proxy-integration happy paths, but the TTL
//   boundary, expiresAt arithmetic, purgeClientCache (ZERO coverage),
//   stableStringify's null/undefined/primitive/array edge cases, and
//   both test-only helpers' own effects were thin) -> 96.39% raw
//   (80/83) across 2 verify rounds -> effectively 100% (1 documented
//   equivalent + 2 accepted timeouts). One new
//   `response-cache-mutation.test.ts`, authored directly (19 baseline
//   survivors). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__ src/proxy/__tests__"`.
//   Closed: the TTL `<=` vs `<` expiry-boundary tick (exact-tick clock
//   stubbing); expiresAt's `* 1000` vs `/ 1000` arithmetic (a 100s TTL
//   entry must still be live 50ms later, which only a correct
//   multiplication guarantees); the LRU-eviction loop's `oldest ===
//   undefined` guard (needed a negative `cacheMaxEntries` to drain the
//   store to empty mid-loop — the guard's own forced-false mutant
//   surfaced as a genuine Timeout on verify, same "detected via
//   timeout" convention as the sibling while-body-emptied mutant, not a
//   Killed status); purgeClientCache's entire cluster (had ZERO prior
//   coverage) via one test asserting a target client's keys are dropped
//   AND an unrelated client's keys survive, which simultaneously kills
//   the emptied-body, emptied-prefix, and startsWith<->endsWith-swap
//   mutants; and stableStringify's null/primitive/undefined/array/
//   multi-key-object edge cases (only ever exercised via plain single-
//   level objects before), including a real miss on the FIRST verify
//   round — a single-key-object test can't reach the outer object
//   branch's `.join(",")` separator between MULTIPLE key:value pairs
//   (nothing to join with only one entry), needing a 2-key object to
//   observe the dropped comma. **New finding, unrelated to any mutant**:
//   the file's "space-joined key" doc comment is stale — the actual
//   field separator in all 3 template literals (cacheKey,
//   purgeToolCache's and purgeClientCache's `prefix`) is a literal NUL
//   byte (`\0`), not a space, confirmed via a raw byte read; the file
//   has been binary in git's own eyes since its very first commit.
//   Functionally harmless (the keys are process-local and in-memory
//   only) but flagged to the user rather than silently fixed, since
//   fixing production source is out of scope for a test-only mutation
//   backstop pass.
//   oauth.ts (155 LOC, src/backend-auth/ — outbound OAuth2
//   client-credentials with auto-refresh: config CRUD + a per-client
//   TTL-cached token mint)  86 mutants  66.28% baseline (57/86, the
//   existing oauth.test.ts covers config CRUD + cache-hit/refresh-after-
//   expiry + proxy-injection happy paths, but never inspects the actual
//   outbound mint request, never exercises INVALID_URL/
//   SECRETS_PROVIDER_ERROR, never feeds the mint fetcher a non-ok
//   response/missing access_token/missing expires_in, and never calls
//   getOAuthBearer for an unconfigured client) -> 96.51% raw (83/86)
//   across 2 verify rounds -> effectively 100% (3 documented
//   equivalents). Test dir is CROSS-DIRECTORY:
//   `src/security/__tests__/oauth.test.ts` — a leftover from before
//   backend-auth's files moved out of src/security/. One new
//   `oauth-mutation.test.ts` in that SAME directory (matching the
//   sibling file's location), authored directly (29 baseline
//   survivors). Scope: `STRYKER_TEST_SCOPE="src/security/__tests__"`.
//   Closed: the INVALID_URL branch (a malformed tokenUrl); both
//   directions of the SECRETS_PROVIDER_ERROR ternary (an Error throw vs.
//   a non-Error throw from `encryptSecret`, via `spyOn` on
//   `localProvider.encryptSecret`); `__resetOAuthForTesting`'s own
//   effect (a stale per-client token cache is not reused after a manual
//   reset, and the real clock resumes ticking — neither had ever been
//   observed directly, since every OTHER test immediately re-stubs the
//   clock right after calling it); the entire outbound mint request
//   shape (method/headers/body, with and without a configured scope —
//   no existing test had ever inspected the actual request at all); a
//   non-ok token-endpoint response; a response missing `access_token`;
//   and the `expires_in`-vs-3600-default TTL fork (a real, small
//   `expires_in` forces an early refresh; a missing one falls back to
//   3600s, not `NaN`). **Real miss on the first verify round, worth
//   generalizing**: the non-ok-response test's mocked body initially had
//   no `access_token` field, so forcing the `!resp.ok` guard false still
//   converged on `null` via the DOWNSTREAM "missing access_token" guard
//   firing instead — the same "one guard's forced-false mutant is
//   masked by a later guard reaching the identical conclusion"
//   pattern already seen on quarantine.ts and registry-persistence.ts.
//   Fixed by giving the mocked non-ok response a VALID access_token, so
//   the mutant's fall-through would have produced a real, non-null token
//   instead of independently re-converging on null.
//   upstream-auth.ts (94 LOC, src/backend-auth/ — per-client upstream
//   auth: static bearer/basic/header credential injection)  51 mutants
//   76.47% baseline (39/51, the existing upstream-auth.test.ts covers
//   store CRUD + all 3 auth-type proxy-injection happy paths + one
//   wrong-key decrypt-failure case, but never spies on the decrypt-
//   failure log call, never feeds a "basic"/"header" secret missing one
//   required field, never exercises an unrecognized auth_type, and
//   never calls getUpstreamAuthHeaders for an unconfigured client) ->
//   **100.00% (51/51), clean** in a single verify round. One new
//   `upstream-auth-mutation.test.ts`, in the same
//   `src/security/__tests__/` directory as its sibling (same
//   cross-directory gotcha as oauth.ts), authored directly (12 baseline
//   survivors). Scope: `STRYKER_TEST_SCOPE="src/security/__tests__"`.
//   Closed: the `!row` early-return guard (same "internal crash on a
//   null row is swallowed by the SAME catch block as a genuine decrypt
//   failure" pattern as oauth.ts's `!row` guard — distinguished via a
//   logger spy proving the decrypt-failure log call does NOT fire on
//   the real early-return path); the decrypt-failure log call's exact
//   level/message/meta (the existing wrong-key test proved the proxy
//   proceeds unauthenticated but never inspected the log call itself);
//   basic auth's `username !== undefined && password !== undefined`
//   guard (two tests, each with exactly one field present via an `as
//   unknown as UpstreamSecret` cast to bypass the type system, isolate
//   both halves and the `&&`-vs-`||` swap); header auth's mirror-image
//   `header_name && value !== undefined` guard (same two-test pattern);
//   and the switch's `default: return null;` branch (no existing test
//   had ever configured an unrecognized auth_type at all). No new
//   equivalence classes — every baseline survivor was a genuine,
//   closable gap.
//   redaction.ts (86 LOC, src/content-filtering/ — response-side dot-path
//   field redaction: wildcard-over-array/object, nested descent, store
//   CRUD)  72 mutants  69.44% baseline (50/72, the existing
//   redaction.test.ts covers top-level/nested-path redaction, wildcard
//   over ARRAY elements only, missing-path no-ops, non-JSON input, store
//   CRUD, proxy integration, and the admin route, but never wildcard
//   over OBJECT keys at all) -> 93.06% raw (67/72) across 2 verify
//   rounds -> effectively 100% (3 documented equivalents + 2 accepted
//   timeouts). Test dir is CROSS-DIRECTORY:
//   `src/tool-policies/__tests__/redaction.test.ts` — yet another case
//   of this domain's recurring gotcha (now 4: load-balancer.ts, auth.ts,
//   oauth.ts/upstream-auth.ts, redaction.ts). One new
//   `redaction-mutation.test.ts` in that SAME directory, authored
//   directly (22 baseline survivors). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`. Closed: a null
//   and a primitive intermediate value (isolating the top guard's two
//   halves — the primitive case needed a STRING intermediate with a
//   NUMERIC-STRING leaf specifically, since a NUMBER intermediate with a
//   non-numeric leaf coincidentally no-ops the same way real code does,
//   via `hasOwnProperty` naturally returning false either way — see key
//   findings below); wildcard over OBJECT keys, both leaf and nested
//   (the entire `else`-branch of the wildcard handler had ZERO
//   coverage — only the array branch was ever tested); a named
//   (non-wildcard) segment applied to an array intermediate (needed a
//   NUMERIC-STRING segment specifically, since a real array's
//   `hasOwnProperty("0")` is true, unlike any non-numeric name); a
//   missing LEAF key on an otherwise-present intermediate (isolated from
//   the existing "missing paths are a no-op" test, which only ever hit
//   the EARLIER missing-INTERMEDIATE guard, never actually reaching the
//   leaf-set guard at all); setRedactionPaths' trim/filter-empty
//   pipeline; and a genuine DELETE-vs-empty-UPSERT distinction when
//   clearing (verified via raw SQL, same technique as guardrails.ts's
//   getGuardrails()===null case). Key findings:
//   - **A `bun -e` inline eval does NOT reflect real ES-module strict-mode
//     semantics.** An initial attempt to kill the top guard's
//     `typeof node !== "object"` half used a NUMBER intermediate (`{a:
//     5}`, path `"a.b"`) reasoning it would throw when the mutant
//     bypassed the guard and tried to assign a property to a primitive.
//     `Object.prototype.hasOwnProperty.call(5, "b")` is simply `false`
//     (numbers have no "b" property), so the assignment never even
//     happens — the mutant silently no-ops identically to real code,
//     and the test survived unkilled on the first verify round. A
//     STRING intermediate with a NUMERIC-STRING leaf (`{a: "hello"}`,
//     path `"a.0"`) was needed instead — strings DO expose character
//     indices as real own properties (`hasOwnProperty("hello","0")` is
//     true), so the mutant's bypassed guard reaches a genuine assignment
//     attempt on an immutable string primitive. A quick `bun -e` check
//     of this exact assignment reported "no-throw" (misleadingly),
//     while a standalone `.mjs` script (real ES-module strict-mode
//     context) correctly threw "Attempted to assign to readonly
//     property" — `bun -e`'s inline eval runs in a DIFFERENT (non-
//     strict-equivalent) mode than a real compiled ES module. Any future
//     equivalence check involving strict-mode-only behavior (property
//     assignment to primitives/frozen objects, etc.) needs a real
//     module-context script, not a `bun -e` one-liner, to trust the
//     result.
//   - **New equivalence class: an `Array.isArray(node)` guard is
//     unobservable when EVERY value reaching it originates from
//     `JSON.parse`.** Bypassing the array/object branch split and always
//     falling through to `Object.keys(node)`-based iteration produces
//     BYTE-IDENTICAL output to the array-specific `for` loop for any
//     JSON-sourced array, since JSON arrays only ever contain dense,
//     numeric-string own-enumerable keys enumerated in the same
//     ascending order either way. Verified via a direct `bun -e`
//     comparison of both iteration strategies (this one, unlike the
//     strict-mode case above, is a pure enumeration-order question with
//     no strict-mode dependency, so `bun -e` was trustworthy here).
//     Worth checking on any future file that branches on
//     `Array.isArray` purely to choose an iteration strategy over
//     JSON-sourced data with no other array-specific behavior (sort
//     order, sparse-hole handling, etc.) layered on top.
//   - **New equivalence class: recursing into `undefined` is
//     unobservable when the SAME function's own top guard already
//     filters non-object values.** `obj[head] !== undefined` forced
//     always-true makes a missing property recurse instead of
//     short-circuiting, but `redactInPlace(undefined, rest)` immediately
//     hits this file's OWN `typeof node !== "object"` guard and returns
//     with zero side effects — identical to never recursing at all.
//     Reusable for any future `if (x !== undefined) recurse(x)`-shaped
//     guard whose recursive target ALREADY has its own top-level
//     undefined/null/non-object filter.
//   tool-examples.ts (74 LOC, src/tool-meta/ — saved per-tool playground
//   example args: CRUD + MAX_ARGS_BYTES validation)  31 mutants  77.42%
//   baseline (24/31, the existing tool-examples.test.ts covers the
//   create/list/delete round-trip, an unknown tool, a non-object ARRAY
//   args rejection, cascade-delete, tool-scoped delete, and the admin
//   route, but never a null args value, a non-array PRIMITIVE args
//   value, or either side of the MAX_ARGS_BYTES boundary) ->
//   **100.00% (31/31), clean** in a single verify round. One new
//   `tool-examples-mutation.test.ts` in the SAME cross-directory
//   location as its sibling
//   (`src/tool-policies/__tests__/tool-examples.test.ts`), authored
//   directly (7 baseline survivors). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`. Closed: a null
//   args value (isolates `args===null`, since `typeof null==="object"`
//   in JS makes the first sub-condition false too); a genuine PRIMITIVE
//   non-array args value (the existing "non-object args" test only ever
//   used an ARRAY, which is `typeof "object"` in JS and never isolates
//   the `typeof!=="object"` half at all); an oversized-args rejection;
//   and the exact MAX_ARGS_BYTES (16384) boundary — constructed via
//   `"x".repeat(16384-8)` wrapped in `{a:...}` to hit exactly 16384
//   stringified bytes, proving the check is exclusive (`>`) rather than
//   inclusive (`>=`) of the max. No new equivalence classes.
//   tool-tags.ts (71 LOC, src/tool-meta/ — per-tool tag CRUD:
//   normalize/dedupe, listAllTags/listToolsByTag, getTagsForClient/
//   getAllToolTags)  33 mutants  96.97% baseline (32/33, ALREADY very
//   high — getTagsForClient/getAllToolTags have no dedicated test at
//   all but are exercised indirectly via registry.ts's own
//   getClientDetail/listAllTools integration tests in the same file) ->
//   **100.00% (33/33), clean** in a single verify round. One new
//   `tool-tags-mutation.test.ts`, in the SAME directory as its sibling
//   — this file actually mirrors 1:1
//   (`src/tool-meta/__tests__/tool-tags.test.ts`), UNLIKE
//   tool-examples.ts's cross-directory location; don't over-generalize
//   either pattern within src/tool-meta/. Authored directly (1 baseline
//   survivor — the smallest gap count all session). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-meta/__tests__"`. Closed: `normalizeTag`'s
//   dropped `.trim()` (every tag in the existing test suite was already
//   whitespace-free, so trimming was never observed — one direct call
//   to the exported `normalizeTag("  Billing  ")` closed it). No new
//   equivalence classes. Fastest baseline+verify cycle all session
//   (12s + 11s, thanks to the 2-file `src/tool-meta/__tests__` scope).
//   sanitize.ts (64 LOC, src/content-filtering/ — prompt-injection
//   defense on tool descriptions: 11 SUSPICIOUS_PATTERNS regexes,
//   Unicode NFC/NFD homoglyph normalization, markdown-code-block strip,
//   space-collapse, MAX_DESCRIPTION_LENGTH truncation, wasSanitized/log)
//   78 mutants, an unusually low 48.72% baseline (38/78 — Stryker's
//   regex mutator generates multiple variants per literal across 11
//   patterns, and the Unicode-normalization/wasSanitized/log-call
//   internals had zero dedicated tests) -> **100.00% (78/78), clean**
//   across 2 verify rounds. Test dir mirrors 1:1
//   (`src/content-filtering/__tests__/sanitize.test.ts`, the only file
//   in that scope, no port-binding concerns). One new
//   `sanitize-mutation.test.ts`, authored directly (40 baseline
//   survivors — right at this program's ~40-50 solo-vs-Workflow
//   threshold, but authored solo anyway since most of the mass was the
//   ALREADY-solved regex dual-technique plus a handful of well-scoped
//   clusters, not genuinely novel work needing parallel agents). Scope:
//   `STRYKER_TEST_SCOPE="src/content-filtering/__tests__"`. Closed: the
//   regex dual-technique across all 11 SUSPICIOUS_PATTERNS (character-
//   class-negation `\s`->`\S` on the 3 `\s*`-colon patterns, killed by a
//   realistic positive match with a space before the colon; quantifier-
//   reduction `\s+`->`\s` on the other 8, killed by DOUBLED whitespace —
//   for the 4-gap "do not tell the user" phrase, doubling ALL FOUR gaps
//   at once kills all 4 independent single-gap mutants in one test,
//   since each mutant's one unfixed gap still breaks on the doubled
//   space; "do not reveal" had ZERO prior coverage of any kind, needing
//   both a positive AND a doubled-space test); the homoglyph-defeating
//   Unicode normalization (an accented "Café" -> "Cafe" exact-match
//   test, plus a doesn't-throw test for `char.normalize("")`, a genuine
//   RangeError-inducing mutant); wasSanitized/log() (a clean description
//   must NOT log; a code-block-only, a pattern-only, and a truncation-
//   only description must each independently log, with the pattern-only
//   case asserting the exact level/message/meta); the space-collapse
//   step (4 spaces must collapse to exactly 1, not 0); and the
//   truncation boundary's `trimEnd()` vs `trimStart()` (needed a slice
//   ending in whitespace with no leading whitespace, to make the two
//   diverge). Key findings:
//   - **A doubled-whitespace test string can pass its OWN assertion for
//     the wrong reason if the assertion checks for the doubled-spaced
//     substring instead of the collapsed single-spaced one.** The
//     pipeline's LATER, unconditional space-collapse step
//     (`replace(/\s{2,}/g," ")`) normalizes ANY leftover doubled
//     whitespace down to one space regardless of whether the injection
//     pattern actually matched — so `.not.toContain("you  must")`
//     (double-spaced) passes trivially under BOTH real code (removed
//     entirely) AND the quantifier-reduced mutant (left in place, then
//     collapsed to "you must" — no longer double-spaced either). The
//     first verify round's 5 survivors (you must / ignore all / forget
//     your / act as / pretend to) were all this SAME mistake; fixed by
//     asserting absence of the SINGLE-spaced remnant instead. Any future
//     test proving "X was stripped" alongside a later normalization step
//     must assert against what the normalization step would ITSELF
//     produce from the unstripped input, not the raw pre-normalization
//     form.
//   - **A `bun -e` equivalence investigation can be locally correct but
//     still miss that Stryker generates several INDEPENDENT mutations on
//     the same span.** An initial pass suspected `char.normalize("NFD")
//     .replace(/[̀-ͯ]/g,"") || char`'s fallback was a documented
//     equivalent, reasoning (correctly, verified across every codepoint
//     in `[À-ÿ]`) that the right-hand `|| char` fallback never
//     actually activates. But Stryker's ConditionalExpression/
//     LogicalOperator mutators on that SAME span don't just test "does
//     the fallback activate" — forcing the whole expression to a fixed
//     boolean breaks the NORMAL (left-side-truthy) case too, which the
//     "Café" exact-match test already killed on the very first verify
//     round without any dedicated fallback test. Always check the
//     verify-round survivor list before writing a mutant off as
//     equivalent — reasoning about one specific sub-scenario doesn't
//     mean every mutation Stryker generated on that span shares the same
//     fate.
//   tool-mock.ts (58 LOC, src/tool-meta/ — per-tool mock/
//   virtualization: "always"/"fallback" canned-response config CRUD)
//   23 mutants, 95.65% baseline (22/23) -> **100.00% (23/23), clean**
//   in a single verify round (first try). NOTE: yet another naming
//   gotcha — its dedicated test is NOT `tool-mock.test.ts`, it's plain
//   `src/tool-policies/__tests__/mock.test.ts` (the "tool-" prefix is
//   dropped from the test filename entirely). Also has indirect
//   coverage from proxy.ts's own C6/C7/C11 dispatch-pipeline test
//   files, out of scope here (those exercise proxy.ts's OWN mock-
//   branching logic, not this file's simple config CRUD). One new
//   `tool-mock-mutation.test.ts` in `src/tool-policies/__tests__/`,
//   authored directly (1 baseline survivor). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`. Closed:
//   `row.enabled === 1` forced always-true, never observed since every
//   existing test only ever persisted `enabled: true` — one direct
//   `enabled: false` round-trip test closed it. No new equivalence
//   classes.
//   tool-sensitivity.ts (48 LOC, src/tool-meta/ — final domain-5 file —
//   destructive-tool gating: explicit sensitive flag, config auto-gate
//   for write methods, CRUD)  38 mutants, 68.42% baseline (26/38, the
//   existing tool-sensitivity.test.ts covers the proxy-level
//   confirmation gate + elevated-key bypass + auto-gate for DELETE +
//   an explicit override, but never an unknown tool, never clearing a
//   flag back to null, never method PUT or a non-write method, never
//   auto-gate disabled with a write method, and never
//   getSensitivityForClient at all) -> **100.00% (38/38), clean** in a
//   single verify round (first try). Test dir mirrors 1:1
//   (`src/tool-meta/__tests__/tool-sensitivity.test.ts`, the same
//   2-file scope as tool-tags.ts). One new
//   `tool-sensitivity-mutation.test.ts`, authored directly (12 baseline
//   survivors). Scope: `STRYKER_TEST_SCOPE="src/tool-meta/__tests__"`.
//   Closed: an unknown-tool `setToolSensitive` call (returns exactly
//   `false`, not `true`); clearing via `null` genuinely deletes the row
//   (verified via raw SQL, same technique as guardrails.ts's
//   getGuardrails()===null case); all 4 quadrants of the auto-gate's
//   `autoGateWriteMethods && (method==="DELETE"||method==="PUT")`
//   expression (the existing test only ever tried the all-true
//   quadrant — enabled+DELETE — leaving the other 3 completely
//   unobserved: enabled+non-write, disabled+write, and enabled+PUT
//   specifically, the last also needed to kill the PUT-string-literal
//   and `===`/`!==` mutants on that comparison); and
//   `getSensitivityForClient`, which had ZERO prior coverage of any
//   kind. No new equivalence classes.
//
// ── DOMAIN 5 (src/tool-policies + src/tool-meta + src/content-filtering
// + src/backend-auth, 16 files, ~2311 LOC) COMPLETE. ── Final roster,
// all effectively 100% (most exactly 100%): context-budget.ts,
// load-balancer.ts, quarantine.ts, guardrails.ts, pagination.ts,
// response-cache.ts, oauth.ts, upstream-auth.ts, redaction.ts,
// tool-examples.ts, tool-tags.ts, sanitize.ts, tool-mock.ts,
// tool-sensitivity.ts — 14 files, 21 commits across several sessions.
// Recurring gotchas worth remembering for future domains: (1)
// cross-directory test locations are COMMON but not universal even
// within the same source directory (src/tool-meta/ alone has both
// cross-directory files like tool-examples.ts/tool-mock.ts AND 1:1-
// mirrored ones like tool-tags.ts/tool-sensitivity.ts) — always verify
// per file via find/ls, never assume from a sibling's location; (2)
// test FILENAMES can also drop prefixes (tool-mock.ts -> mock.test.ts)
// independent of directory location; (3) the regex dual-technique
// (character-class-negation needs a positive match, quantifier-
// reduction needs a doubled/near-miss negative) recurs on every regex-
// heavy file and generalizes cleanly; (4) a `bun -e` inline eval does
// NOT reflect real ES-module strict-mode semantics — verify
// strict-mode-dependent equivalence claims (property assignment to
// primitives, etc.) with a real standalone script, not `bun -e`; (5)
// always cross-check an "equivalent" write-up against the actual
// verify-round survivor list before finalizing it — reasoning about one
// sub-scenario doesn't cover every mutation Stryker generates on the
// same span. This closes tasks #25-26 in the harness task list.
//
// DOMAIN 6 = src/discovery (4 files, ~1068 LOC). Test dir:
// src/discovery/__tests__/ — most files' tests live directly there, but
// tool-naming.ts (below) is yet another cross-directory case (tests
// from src/tool-policies/__tests__/ instead).
//   tool-naming.ts (58 LOC — shared tool-name normalization for
//   auto-discovery sources: camelCase->snake_case, invalid-char
//   substitution, MAX_LEN truncation, and collision disambiguation)
//   34 mutants, 67.65% baseline (23/34, the existing
//   tool-naming.test.ts covers camelCase splitting, single-invalid-
//   char replacement, the empty/all-invalid fallback, a basic 100-char
//   truncation LENGTH check, a single collision suffix, and the
//   max-length-termination regressions — but never multiple
//   CONSECUTIVE invalid chars, never multiple leading non-underscore
//   invalid chars, never the EXACT truncated value, and never a SECOND
//   sequential collision) -> 82.35% raw (28/34) in a single verify
//   round -> effectively 100% (3 documented equivalents + 3 accepted
//   timeouts). Test dir is CROSS-DIRECTORY:
//   `src/tool-policies/__tests__/tool-naming.test.ts`. One new
//   `tool-naming-mutation.test.ts` in that SAME directory, authored
//   directly (11 baseline survivors). Scope:
//   `STRYKER_TEST_SCOPE="src/tool-policies/__tests__"`. Closed: the
//   `/_+/g` collapse-runs regex's quantifier reduction (two consecutive
//   spaces must collapse to ONE underscore, not survive as two — the
//   existing tests only ever produced one invalid char at a time); the
//   `/^[^a-z0-9]+/` leading-strip regex's quantifier reduction (needed
//   TWO leading HYPHENS specifically, since consecutive underscores are
//   already collapsed to one by the prior step, leaving hyphens as the
//   only way to still have a multi-char leading invalid run at this
//   point); the dropped `.slice(0, MAX_LEN)` truncation call (the
//   existing test's `length <= 63` check is ALSO satisfied by the "op"
//   fallback an untruncated 100-char string falls into, since
//   TOOL_NAME_RE itself caps total length — only an EXACT value
//   assertion distinguishes "63 a's" from "op"); and
//   `uniqueToolName`'s suffix-direction (`suffix++` vs `suffix--`) —
//   a SINGLE collision can't distinguish these since post-increment/
//   decrement both read the ORIGINAL value on first use; needed a
//   SECOND sequential collision on the same base name to observe which
//   direction the suffix actually moves next. 3 documented equivalents:
//   `TOOL_NAME_RE.test(truncated) && truncated.length > 0`'s length
//   check is provably redundant — `TOOL_NAME_RE`
//   (`/^[a-z0-9][a-z0-9_-]{0,62}$/`) REQUIRES a non-empty match, and
//   every value truncated can actually take (given the guaranteed
//   character-class + leading-char + length-cap properties of steps
//   27-31) already satisfies the regex whenever it's non-empty —
//   verified via `bun -e` brute-forcing a wide variety of inputs
//   through the real pipeline. 3 accepted genuine timeouts (do-while
//   body emptied, template-literal emptied causing a permanently
//   unchanging candidate, and an arithmetic `+`->`-` flip coercing to
//   `NaN` which a Set treats as equal to itself once added) — all
//   already detected by the pre-existing "keeps disambiguating across
//   many collisions" regression test, no new test needed.
//   openapi-discovery.ts (228 LOC, src/discovery/ — OpenAPI/Swagger
//   auto-discovery: fetch+DNS-pin, size limits, JSON/YAML parse,
//   circular-reference rejection, iterative-BFS depth cap, dereference,
//   operation-to-tool mapping, generateToolName, buildInputSchema)
//   211 mutants, 51.18% baseline (108/211, decent existing coverage of
//   the happy paths across 3 test files — openapi-discovery.test.ts,
//   openapi-discovery-depth.test.ts, openapi-discovery-pin.test.ts —
//   but the size-limit boundaries, several optional-chaining/fallback
//   guards, generateToolName (never exercised — every existing test
//   supplies an operationId), and most of buildInputSchema's individual
//   field-mapping branches were thin) -> 96.68% raw (204/211) across 2
//   verify rounds -> effectively 100% (6 documented equivalents + 1
//   accepted timeout). Test dir mirrors 1:1
//   (`src/discovery/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/discovery/__tests__"`. Given the LARGE
//   survivor count (103, well past this program's ~40-50 solo-vs-
//   Workflow threshold), used a **5-agent parallel Workflow** — one
//   agent per functional cluster (od1: fetch/size-limits/cycle-
//   detection/depth-cap BFS; od2: dereference-errors/paths-guard/
//   basePath; od3: operation-loop-guards/name-mapping/
//   generateToolName; od4: buildInputSchema parameter mapping; od5:
//   buildInputSchema request-body merging) — each authoring its own
//   `openapi-discovery-mutation-{od1..od5}.test.ts` (33 tests total),
//   followed by one manual closing pass
//   (`openapi-discovery-mutation-final.test.ts`, 4 tests) for the 4
//   real gaps the cold round left plus verifying/correcting 2 of the
//   agents' own already-investigated equivalence claims. Workflow cost:
//   ~435k subagent tokens / 116 tool calls across 5 agents (~12 min
//   wall-clock) took baseline 51.18% -> 94.79% (200/211 after cold
//   round); the closing pass then fixed the last 4 real gaps —
//   consistent with every other large multi-agent file in this
//   program (context-budget.ts, registry.ts, guardrails.ts): a cold
//   parallel round gets most of the way there fast, but always budget
//   a manual pass. Key findings from the closing pass:
//   - **`sanitizeToolName`'s OWN normalization pipeline can mask
//     mutants in the function that FEEDS it.** `generateToolName`'s
//     result is ALWAYS immediately passed through `sanitizeToolName`
//     at its only call site (`opId ?? generateToolName(...)`), which
//     itself unconditionally lowercases (masking a
//     `.toLowerCase()`->`.toUpperCase()` mutant in generateToolName
//     completely — genuine equivalent, verified empirically) and
//     collapses repeated underscores (masking MOST but not all
//     artifacts from generateToolName's own `.filter(Boolean)` being
//     dropped — a LEADING or INTERIOR empty path segment collapses
//     away identically either way, but a TRAILING one survives, since
//     sanitizeToolName only strips LEADING invalid characters, never
//     trailing ones — a path ending in "/" is the one case that isn't
//     masked). Any future file with a similar
//     "helper-feeds-into-a-normalizing-caller" structure should check
//     whether the caller's OWN normalization steps mask the callee's
//     mutants before assuming a test targeting the callee in isolation
//     is even possible.
//   - **A `?? fallback` value's mutant can be unobservable when the
//     fallback is consumed by exactly ONE narrow check that any
//     placeholder text will also fail identically.** `doc.servers?.
//     [0]?.url ?? ""`'s fallback text, mutated to Stryker's own
//     "Stryker was here!" placeholder, is only ever consumed by a
//     subsequent `serverUrl.startsWith("/")` check — since the
//     placeholder doesn't start with "/" either, both the real ""
//     and the mutant text produce an IDENTICAL empty basePath for
//     every reachable input. Genuine equivalent, verified empirically
//     (not assumed) by tracing the value's only consumer.
//   - **Two test cases can each independently "look like" they
//     discriminate a MethodExpression swap (e.g. `startsWith`<->
//     `endsWith`) while actually both producing identical results
//     under both versions.** The cold round's two basePath test cases
//     ("/api/v1/" and an absolute URL) both coincidentally have
//     matching start/end characters (one starts AND ends with "/", the
//     other starts with neither) — verified empirically that BOTH
//     mutant and real code produce the same output for both cases. A
//     THIRD case (a relative path starting with "/" but NOT ending
//     with it) was needed to actually discriminate. General lesson:
//     when testing a directional method swap, deliberately choose an
//     input where the two directions' predicates disagree, not just
//     an input that happens to satisfy the intended one.
//   - **`@scalar/openapi-parser`'s `dereference()` return shape is
//     more guaranteed than its TypeScript types suggest.** Both
//     `errors` and `schema` are typed as optional
//     (`errors?: ErrorObject[]`, `schema?: OpenAPI.Document`) but the
//     real implementation ALWAYS returns `errors` as an array (`[]`
//     when clean, verified via a direct empirical call) and `schema`
//     as a truthy object on every reachable path — making the
//     corresponding `errors?.length`/`schema?.paths` optional-chaining
//     mutants genuine equivalents for this specific library's actual
//     (not just typed) behavior. Don't assume a library's TypeScript
//     optionality reflects real runtime possibility — call it directly
//     and inspect the actual return value before writing an
//     equivalence claim.
//   graphql-discovery.ts (313 LOC, src/discovery/ — GraphQL
//   introspection auto-discovery: unwrap/printTypeRef/scalarToJsonType
//   helpers, typeToJsonSchema, buildSelectionSet, synthesizeQuery,
//   fieldToTool, discoverToolsFromGraphQl)  272 mutants, 43.38%
//   baseline (118/272 — the existing test covers the happy path for
//   query+mutation discovery, collision handling, includeMutations,
//   and the introspection-disabled/errors/too-many-types guards, but
//   the individual type-mapping branches, the deeply recursive
//   buildSelectionSet, and most fetch/size-limit details were thin) ->
//   98.16% raw (267/272) across 2 verify rounds -> effectively 100% (5
//   documented equivalents). Test dir mirrors 1:1
//   (`src/discovery/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/discovery/__tests__"`. Given the
//   VERY LARGE survivor count (154, the largest cold-round count all
//   session), used a **5-agent parallel Workflow** — one agent per
//   functional cluster (gd1: unwrap/printTypeRef/scalarToJsonType/
//   typeToJsonSchema, 40 survivors; gd2: buildSelectionSet alone, 62
//   survivors — the single densest cluster this whole program has
//   seen; gd3: synthesizeQuery/fieldToTool, 12; gd4:
//   discoverToolsFromGraphQl's fetch/size-limits/JSON-parse/cyclic-
//   check, 29; gd5: discoverToolsFromGraphQl's errors/introspection-
//   disabled/too-many-types/field-iteration, 11) — each authoring its
//   own `graphql-discovery-mutation-{gd1..gd5}.test.ts` (57 tests
//   total, ~415k subagent tokens / 71 tool calls / ~8 min wall-clock,
//   cold round drove 43.38%->95.59% raw, 12 survivors), followed by
//   one manual closing pass
//   (`graphql-discovery-mutation-final.test.ts`, 5 new tests) fixing
//   the 7 real gaps and confirming 5 documented equivalents.
//   Key findings:
//   - **An agent independently re-verified the task's own mutant
//     citations against the actual Stryker JSON report and caught a
//     mislabeling.** The gd3 agent's prompt (authored by the
//     orchestrating session, not Stryker itself) mis-described two
//     survivors as the `usedNames.has(base)` collision check at lines
//     214/216 — the agent cross-checked `reports/mutation/result.json`
//     directly and found the ACTUAL mutants at those coordinates were
//     the `arg.description` guard and the `defaultValue == null`
//     comparison instead (the collision check itself had ZERO
//     survivors, already fully killed). It targeted the real mutants,
//     not the mis-described ones. General lesson for future multi-
//     agent prompts in this program: always tell agents to verify
//     citations against the raw JSON report rather than trusting
//     prose-transcribed line:col descriptions — copy/summarization
//     errors in the ORCHESTRATING session's own prompt are a real,
//     now-observed failure mode, not just a hypothetical one.
//   - **The manual closing pass found TWO test-construction traps that
//     both independently produced a false sense of coverage**: (1) a
//     `.join(", ")` separator mutant survived because the test used a
//     field with only ONE arg — with a single-element array, `.join`
//     never has anything to actually join, so the separator's value
//     never gets consulted regardless of what it is; needed a 2+-arg
//     field to exercise it. (2) An `?? []` fallback-array mutant
//     survived because the test happened to construct a scenario where
//     the placeholder's own content got filtered out by a LATER
//     `.filter((t) => t.name)` step regardless of which fallback fired
//     (a plain string element has no `.name`, so it's dropped from the
//     resulting Map either way) — needed a test that inspects
//     `types.length` directly via a boundary check (a `graphqlMaxTypes`
//     cap forced to exactly 0) instead of relying on the placeholder's
//     content surviving downstream.
//   - **Two type-mapping guards (`kind === "ENUM"`, `kind ===
//     "INPUT_OBJECT"`) needed deliberately MALFORMED fixtures to
//     isolate their forced-true mutants** — every well-formed
//     introspection fixture keeps `kind` and the corresponding data
//     field (`enumValues`/`inputFields`) mutually consistent (a type
//     that's actually kind ENUM genuinely has enumValues), so forcing
//     either kind-check to always-true never diverges from real
//     behavior on any REALISTIC fixture. The code itself never
//     validates this consistency, so a fixture with kind:"OBJECT" but
//     a POPULATED enumValues/inputFields array (never sent by a real
//     GraphQL server, but not rejected by this code either) is what
//     actually distinguishes the forced-true mutant from real
//     behavior. General lesson: when a type-tag field and a
//     corresponding payload field are checked together but never
//     cross-validated by the code under test, an internally-consistent
//     fixture can't isolate a forced-true mutant on the tag check
//     alone — deliberately construct an inconsistent one.
//   - **A recursive function's own type-reference `kind` field, not
//     the typeMap entry's `kind` field, drives its branching.**
//     `buildSelectionSet`'s `named.kind === "UNION"` check reads
//     `kind` off the TYPE REFERENCE object (e.g. a field's `type:
//     {kind, name, ofType}`), not off the separately-looked-up
//     `typeMap.get(name)` entry — a fixture that sets the WRONG one
//     (e.g. hard-coding the type reference's kind to "OBJECT" while
//     only the typeMap entry says "UNION") silently fails to exercise
//     the intended branch at all, with no error to signal the mistake
//     (caught and fixed during this file's own closing pass). Whenever
//     a recursive/graph-walking function reads a tag from one of TWO
//     structurally-similar objects (a reference vs. its resolved
//     target), double-check which one the actual conditional reads
//     from before trusting a fixture's shape.
//   curl-postman-discovery.ts (469 LOC, src/discovery/ — the largest
//   domain-6 file and the final one: tokenizeShellLike, parseCurlCommand/
//   parseSingleCurlCommand, parsePostmanCollection/parsePostmanLeaf, and
//   the shared toParsedUrl/extractPathAndQuery/extractBodyKeys/
//   generateNameFromPath/describeSource helpers)  580 mutants, the
//   LARGEST cold-round survivor/timeout count in this entire program
//   (252 survivors + 27 timeouts baseline) -> 95.17% raw-detected
//   (513 killed + 39 accepted timeouts, 552/580) across 1 verify round
//   after the cold round plus 1 closing pass -> effectively 100% (all
//   28 raw survivors are documented equivalents). Test dir mirrors 1:1
//   (`src/discovery/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/discovery/__tests__"`. Given the scale, used
//   a **5-agent parallel Workflow** — one agent per functional cluster
//   (cp1: tokenizeShellLike + CURL_BOOLEAN_FLAGS/SUPPORTED_METHODS; cp2:
//   parseSingleCurlCommand's flag-parsing loop; cp3:
//   parsePostmanCollection's top-level validation + walk() +
//   parsePostmanLeaf; cp4: extractPostmanUrl + extractPostmanBodyKeys;
//   cp5: the shared helpers toParsedUrl/extractPathAndQuery/
//   extractBodyKeys/generateNameFromPath/describeSource) — each authoring
//   its own `curl-postman-discovery-mutation-{cp1..cp5}.test.ts` (73
//   tests total), followed by one manual closing pass
//   (`curl-postman-discovery-mutation-final.test.ts`, 6 tests) fixing 5
//   real gaps the cold round left plus confirming 1 new equivalent.
//   Learning from graphql-discovery.ts's orchestrator-citation-error
//   lesson, each cp agent was told up front to re-query
//   `reports/mutation/result.json` directly rather than trust prose —
//   this round had zero citation-mislabeling incidents. Key findings:
//   - **A backward-walking escape-scan mutant is a genuine, real
//     infinite loop — not just theoretically hangable.** `j += 2` (the
//     double-quote escape handler's index advance) flipped to `j -= 2`
//     sends `j` walking BACKWARD once it passes a mid-string escape,
//     re-scanning the same characters forever; confirmed via a
//     hand-simulated copy with a 1000-iteration safety guard before
//     writing the real test, which is expected (and confirmed) to
//     surface as a Stryker Timeout, not a Killed status.
//   - **A `typeof x !== "string"` guard's forced-true half is only
//     observable with a genuinely NON-STRING input, not an empty
//     string.** Every existing empty/whitespace-only test already used
//     a real string, for which this half of the guard was already false
//     regardless of the mutation — needed a literal `null` passed
//     through a type-cast to bypass the TS type at the JS boundary.
//   - **A line-continuation replacement-space mutant needs a
//     continuation with NO other adjacent whitespace.** The cold round's
//     two tests both coincidentally had a real whitespace character
//     already sitting next to the backslash+newline match (from
//     surrounding text), so dropping the match's OWN replacement space
//     left an unrelated space behind anyway; needed a continuation
//     sitting directly between two words with nothing else nearby.
//   - **The SAME "caller normalization masks a helper's mutant" pattern
//     already seen on openapi-discovery.ts's generateToolName recurred
//     here for the Postman folder-label join.** The cold round's
//     Capitalized segment-name fixture ("Alpha"/"Beta"/"Widget") let
//     `sanitizeToolName`'s OWN camelCase-boundary regex
//     (`replace(/([a-z0-9])([A-Z])/g, "$1_$2")`) reinsert the exact same
//     underscores a dropped `.join("_")` separator would have provided;
//     all-LOWERCASE segment names avoid the masking entirely. The
//     `.filter(Boolean)` drop needed a SEPARATE fixture (a genuinely
//     empty leaf name, not undefined) since sanitizeToolName only strips
//     LEADING invalid characters, not trailing ones.
//   - **A `.trim()` drop on a literal-path URL fallback needs a fixture
//     with actual surrounding whitespace** — the cold round's
//     unparseable-URL fixtures never had any whitespace to strip.
//   - **New genuine equivalent**: `parsed !== null` forced always-true
//     in extractBodyKeys' JSON-object-shape check. For any non-null
//     parsed value this was already true regardless of the mutation; for
//     a JSON body that's literally `null`, the forced-true mutant
//     attempts `Object.keys(null)` (throws) inside the SAME try block
//     that wraps the original `JSON.parse` call, so it's caught by the
//     SAME catch (a no-op) and falls through to the urlencoded-regex
//     fallback, which can't match the literal text "null" either — both
//     real and mutant converge on the identical final `[]`. Verified via
//     a hand-traced simulation of both routes reaching the same result.
//   - Every one of the 28 final raw survivors cross-referenced cleanly
//     against the 5 agents' own already-investigated equivalence claims
//     (10 in cp1's tokenizeShellLike main loop, 3 in cp2's tokens.length/
//     t.length boundary checks, 2 in cp3's item-typeof/header-filter
//     checks, 5 in cp4's Postman-URL `[]`-fallback family, 7 in cp5's
//     toParsedUrl/extractBodyKeys/generateNameFromPath family) plus the
//     1 new equivalent (parsed!==null) found in the closing pass — zero
//     NEW unexplained gaps after the closing pass's 5 fixes, a first for
//     a file this large in the program.
//
// ── DOMAIN 6 (src/discovery, 4 files: tool-naming.ts, openapi-
// discovery.ts, graphql-discovery.ts, curl-postman-discovery.ts) COMPLETE.
// This closes out the largest cold-round survivor/timeout count seen in
// the whole program (curl-postman-discovery.ts's 279) with zero
// unexplained gaps remaining after just one closing pass. Domains 7-10
// remain entirely unstarted: src/observability (10 files), src/routes +
// src/routes/admin, src/admin, and the remaining misc (src/lib, src/cli,
// src/catalog, src/secrets, src/config*, ws-proxy.ts, server.ts,
// index.ts). Multi-session program, not finishable in one sitting. ──
//
// DOMAIN 7 — src/observability/ (10 files, ~1955 LOC). 7 of the 10 files
// already have a dedicated test file directly under
// src/observability/__tests__/ (health.ts, traffic.ts, tracing.ts,
// trace-context.ts, trace-store.ts, usage.ts, metrics.ts); anomaly.ts,
// monitor.ts, and alerts.ts have none.
//   anomaly.ts (46 LOC — usage-spike detection: detectUsageSpike compares
//   a recent-window call rate against a preceding baseline-window rate)
//   28 mutants, 82.14% baseline (23/28, from the existing dedicated test
//   covering the 4 main spike/no-spike scenarios) -> 96.43% raw (27/28)
//   in a single verify round -> effectively 100% (the 1 raw survivor is a
//   documented equivalent). Test dir is CROSS-DIRECTORY (same gotcha
//   class as domain 5's backend-auth and domain 3's load-balancer.ts):
//   the dedicated test lives at
//   `src/admin/entities/__tests__/anomaly.test.ts`, not
//   `src/observability/__tests__/` — new
//   `anomaly-mutation.test.ts` added to that SAME cross-directory
//   location. Scope: `STRYKER_TEST_SCOPE="src/observability/__tests__
//   src/admin/entities/__tests__"`. One new test file, authored directly
//   (5 baseline survivors, small enough for one pass, no agent round).
//   Closed: two `?? default` fallbacks (`opts.factor ?? 3`,
//   `opts.minCalls ?? 20`) mutated to `&&` — only observable with an
//   explicit TRUTHY value distinct from the literal default (both
//   operators agree whenever the left side is falsy/nullish, and the
//   existing tests always passed the SAME value as the default, e.g.
//   `factor: 3`, masking the mutant); an exact `recent.calls === minCalls`
//   boundary (`>=` vs `>`); and an exact `recentRate === baselineRate *
//   factor` threshold boundary (`>=` vs `>`), computed by hand from the
//   real default windows (5-min recent, 60-min baseline) to land exactly
//   on the boundary with no floating-point risk. One documented
//   equivalent: `baselineRate === 0 ? true : ...` forced to always take
//   the else branch. Verified genuinely unobservable: `recent.calls`/
//   `baseline.calls` are SQL `COUNT(*)` results (always >= 0), and
//   `config.anomalyRecentWindowMs`/`anomalyBaselineWindowMs` are read via
//   `Number(process.env.X) || <default>` — the `||` fallback means an
//   env value of 0 (or unset/NaN) can never actually produce a
//   zero-or-negative window, only the positive default — so whenever
//   baselineRate genuinely is 0, `recentRate` is always a non-negative
//   finite number, making `recentRate >= 0` (the mutant's recomputed
//   check) unconditionally true too, same as the real code's direct
//   `true`. Next: monitor.ts (227 LOC — turned out to have an existing
//   dedicated test too, same cross-directory gotcha as anomaly.ts; see
//   its own entry below).
//   monitor.ts (227 LOC — synthetic monitoring + schema-drift detection:
//   setMonitor/deleteMonitor/listMonitors CRUD, runSyntheticChecks'
//   replay+drift-check+notify loop, notifyMonitor's webhook dispatch)
//   121 mutants, 60.33% baseline (73/121) -> 97.52% raw (118/121) across
//   2 verify rounds -> effectively 100% (3 documented equivalents). Test
//   dir is CROSS-DIRECTORY (same gotcha class as anomaly.ts): the
//   dedicated test lives at
//   `src/admin/entities/__tests__/monitor.test.ts`, not
//   `src/observability/__tests__/` — the new
//   `monitor-mutation.test.ts` was added to that SAME location. Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__
//   src/admin/entities/__tests__"`. One new test file, authored directly
//   (48 baseline survivors across many small clusters, still solo-sized
//   given the file's moderate scope — no agent round). Key findings:
//   - **`rowTo`'s boolean-flag mapping and `setMonitor`'s interval
//     boundary were both completely unasserted** despite existing tests
//     exercising the surrounding CRUD — the existing test never checked
//     `.enabled` on a returned record, nor the exact 1/1440 boundary
//     values (only 0, already-invalid).
//   - **The whole `error` field (as opposed to `status`) was never
//     asserted at all** — closed an 8-mutant cluster (ConditionalExpression
//     x2, EqualityOperator, BooleanLiteral, LogicalOperator, MethodExpression,
//     plus 2 genuine equivalents) with 3 new tests: an exact short-body
//     error string, a >500-char body proving `.slice(0, 500)` actually
//     truncates (a short body can't distinguish a dropped slice from a
//     real one), and a successful check clearing `lastError` to `null`.
//   - **New equivalence-reasoning pattern: a helper's own return-shape
//     guarantee can make a `?.`/`?? fallback` pair fully unreachable,
//     the same class already seen on mcp-upstream.ts and
//     openapi-discovery.ts.** `result.content[0]?.text ?? "error"` looks
//     defensive, but EVERY `isError: true` result reaching this line was
//     built through `toolResult()` (src/lib/mcp-result.ts), which always
//     returns a single-element content array with a real `.text` string
//     — `result.content[0]` can never actually be nullish on any
//     reachable proxyToolCall output, so neither the `?.` nor the `??`
//     fallback ever fires.
//   - **A "does it throw" assumption about a null-guard mutant turned
//     out wrong once actually traced through the surrounding code.**
//     `if (!row) return null;`'s forced-false mutant looked like it
//     should throw on `row.args_json` (row is null) instead of
//     returning early — but that property access sits INSIDE the very
//     next `try { return JSON.parse(row.args_json) ... } catch { return
//     null; }` block, so the TypeError is caught by the SAME catch that
//     handles a malformed-JSON body, converging on the identical
//     `return null` either way. Verified empirically (a hand-simulated
//     copy) before accepting — a reminder that "this looks like it
//     should throw uncaught" is a hypothesis to check against the
//     ACTUAL surrounding try/catch structure, not a conclusion.
//   - **A no-op guard (`if (deleted) sideEffect()`) needs a fixture
//     where the side effect would be OBSERVABLE if wrongly fired, not
//     just "delete something that doesn't exist."** The first attempt
//     at testing `deleteMonitor`'s `if (deleted) await
//     annotateToolDrift(...)` guard (delete a monitor that was never
//     created) didn't kill the forced-true mutant, because clearing a
//     drift note that was never set is a no-op regardless of whether
//     the guard fires. Needed a monitor with an ACTIVE drift note whose
//     underlying row was then removed via a raw SQL DELETE (bypassing
//     `deleteMonitor` itself, so nothing ever calls
//     `annotateToolDrift(null)` under real code) — proving the guard is
//     genuinely load-bearing: real code leaves the dangling note alone
//     (`deleted` is false), the forced-true mutant would incorrectly
//     clear it.
//   - **Spying directly on a collaborator (`dispatchWebhook`,
//     `log`) is far simpler than standing up a real HTTP server for a
//     webhook-payload assertion.** `notifyMonitor`'s entire guard +
//     exact payload/options cluster (9 survivors: the `if (!url)`
//     guard's 3 variants, the payload object literal, the options
//     object, and 2 log-message literals) closed with 2 tests using
//     `spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true)` —
//     one proving the guard skips the call with no URL configured, one
//     asserting the exact call args with a URL configured — no SSRF
//     config dance or real Express server needed, since `void
//     notifyMonitor(...)`'s fire-and-forget call still invokes the
//     (mocked) `dispatchWebhook` SYNCHRONOUSLY before its own first
//     `await`, so the spy's call is already recorded by the time
//     `runSyntheticChecks` returns.
//   Next: alerts.ts (261 LOC — turned out to ALSO have an existing
//   dedicated test, same cross-directory gotcha; see its own entry
//   below).
//   alerts.ts (261 LOC — alert rule CRUD + periodic condition
//   evaluation: evaluateCondition's 5 event-type switch cases
//   (client_unreachable/circuit_breaker_open/error_rate/usage_spike/
//   schema_drift/default), edge-triggered evaluateAlerts loop,
//   dispatchAlertWebhook, sendTestAlert, startAlertLoop) 161 mutants,
//   43.48% baseline (70/161) -> 99.38% raw (160/161) in a SINGLE verify
//   round -> effectively 100% (1 documented equivalent). Test dir is
//   CROSS-DIRECTORY (3rd domain-7 file in a row, same pattern as
//   anomaly.ts/monitor.ts): dedicated test at
//   `src/admin/entities/__tests__/alerts.test.ts`. Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__
//   src/admin/entities/__tests__"`. The LARGEST domain-7 survivor count
//   (91, comparable to guardrails.ts's 91) — used a **5-agent parallel
//   Workflow**, one agent per cluster (ac1: top-of-file CRUD —
//   ALERT_EVENT_TYPES/rowToRule/getAlertRule/updateAlertRule/
//   deleteAlertRule; ac2: client_unreachable + circuit_breaker_open
//   switch cases; ac3: error_rate switch case, the densest single case
//   in the file; ac4: usage_spike + schema_drift + default cases +
//   dispatchAlertWebhook; ac5: markFired + evaluateAlerts +
//   sendTestAlert + startAlertLoop) — each authoring its own
//   `alerts-mutation-{ac1..ac5}.test.ts` (9+18+8+7+6 = 48 tests total).
//   TWO of the five agents (ac2, ac4) hit a genuine mid-response server
//   error and had to be recovered: ac2 had already written a complete,
//   correct test file before erroring (just 2 minor TS tuple-length
//   type errors in a `spy.mock.calls[0]` cast, fixed by hand — the cast
//   needs 3 tuple elements since `dispatchWebhook(url, payload,
//   options)` takes 3 positional args); ac4 left NO file at all and was
//   retried from scratch as a single direct Agent call (not a full
//   Workflow re-run) — succeeded cleanly on retry, 7 tests, 17/17
//   targeted mutants. Reached effectively 100% in a SINGLE combined
//   verify round — no 2nd round needed, a first for a Workflow-scale
//   file this large in the program. One documented equivalent (found by
//   the ac4 agent, verified via a standalone `.mjs` scratch script):
//   `{ active: false, detail: {} }` (the `default` switch case's return
//   value) collapsed to `{}` is unobservable, since `undefined` and
//   `false` are both falsy in every branch condition `evaluateAlerts`
//   checks, and `detail` is only ever read when `active` is truthy
//   (never true for either variant) — confirmed identical
//   (dispatched, nextState) outcomes across every reachable prior
//   `lastState` value. Key findings from the individual clusters: a
//   numeric-string `id` passed to `getAlertRule`'s
//   `!Number.isInteger(id)` guard was verified (via a scratch
//   `bun:sqlite` probe) to actually MATCH a row if the guard were
//   skipped, thanks to SQLite's type-affinity coercion — confirming the
//   guard is a real, exploitable gap, not just paranoia; and the dense
//   10-mutant `error_rate` boundary cluster (`summary.calls >= minCalls
//   && summary.errorRate >= threshold`) needed 4 separate boundary
//   scenarios (both operands at their exact threshold, and each
//   direction of "one side true, other false") to fully pin down `&&`
//   vs `||` plus each side's own `>=`-vs-other-comparator variants — the
//   same "N-way boundary combination" pattern seen on this program's
//   other compound-condition clusters (rate-limiter.ts,
//   quarantine.ts).
//
//   health.ts (126 LOC — the leader-gated background health-check loop:
//   per-client REST/MCP probing via checkBatch, consecutive-failure
//   tracking + auto-eviction via handleFailure, and Prometheus metrics
//   for every outcome, all wrapped by startHealthCheckLoop) 89 mutants,
//   an unusually low 22.47% baseline (20/89 — the existing dedicated
//   test only checked 2 Prometheus counters via the real background
//   loop + a short setTimeout wait; almost everything else was
//   untested) -> 98.88% raw (87/89) across 2 verify rounds ->
//   effectively 100% (1 documented equivalent + 1 accepted timeout).
//   Test dir mirrors 1:1 (`src/observability/__tests__/`), unlike its 3
//   domain-7 predecessors. Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. Given the large
//   survivor count (68, comparable to alerts.ts's 91), used a
//   **4-agent parallel Workflow** (hc1: batching loop + MCP-kind
//   client branch; hc2: REST-kind client branch + success-path
//   handling; hc3: failure-path handling + the per-client catch block;
//   hc4: handleFailure in full + startHealthCheckLoop in full) — each
//   authoring its own `health-mutation-{hc1..hc4}.test.ts` (17 tests
//   total). All 4 agents completed cleanly (no server errors this
//   round). A single verify round drove 22.47% -> 97.75% (2
//   survivors); a manual fix closed the 1 real remaining gap, leaving
//   only the 1 already-documented equivalent + 1 accepted timeout.
//   Key findings:
//   - **checkBatch/handleFailure are BOTH module-private** — every
//     test drives them indirectly through the sole exported
//     `startHealthCheckLoop()`: register client(s), start the loop,
//     await a short real delay for its immediately-invoked check tick,
//     call the returned stop() in a try/finally so no interval leaks
//     into a later test file (bun:test runs every file in one
//     process).
//   - **`refreshLeaderStatus()` is a load-bearing beforeEach call, easy
//     to miss** — `startHealthCheckLoop`'s inner check only actually
//     probes backends when the current process believes itself the
//     elected leader (gated by `startLeaderGatedInterval`); a test
//     that forgets this call silently sees the health-check body never
//     execute at all, with no error to signal the mistake.
//   - **A `??` fallback mutated to `&&` on an MCP client's optional
//     fields (mcpUrl/mcpTransport) needed the LIVE registry object's
//     fields cleared directly** — `registerMcp` (or whatever the real
//     registration helper is called) always populates both fields, so
//     the only way to force the `??` fallback arm at all was mutating
//     the already-registered client object's fields to `undefined`
//     directly on the live registry, then configuring a real upstream
//     credential (via `setUpstreamAuth`) so `getUpstreamAuthHeaders`
//     returns a truthy object — needed to distinguish `??` from `&&`
//     (both agree when the left side is falsy).
//   - **A near-instantly-resolving fetch mock makes an
//     elapsed-time-based arithmetic mutant genuinely unobservable by
//     ACCIDENT, not by any real equivalence.** The hc2 agent's cold-round
//     test asserted `duration.sum < 60` to catch a `÷1000 -> ×1000` mutant
//     on `(Date.now() - hcStart) / 1000` — but a verify round showed it
//     surviving anyway. Hand-applying the real mutation and re-running
//     the test confirmed it STILL passed unmodified: with a mocked
//     `fetch` resolving on the same microtask tick, `Date.now() - hcStart`
//     is genuinely `0` within the same millisecond, and `0 / 1000 === 0
//     * 1000 === 0` — mathematically indistinguishable regardless of the
//     operator, no matter how tight the surrounding assertion bound is.
//     Fixed by making the mock resolve after a REAL, measurable
//     `setTimeout` delay (20ms) instead of instantly, guaranteeing a
//     non-zero elapsed gap, then tightening the assertion bound to (0.01,
//     5) seconds (the mutant would produce ~20000 or ~3.4e12 depending on
//     which of the two arithmetic mutants at that span fired). General
//     lesson: whenever a test's kill strategy depends on a REAL elapsed
//     `Date.now()` difference and the surrounding I/O is mocked to
//     resolve instantly, verify empirically (hand-apply the mutation,
//     don't just trust the assertion's apparent logic) — a same-tick
//     mock can make timing-based arithmetic invisible no matter how the
//     bound is written.
//   1 documented equivalent (found by the hc1 agent, verified via a
//   standalone scratch script): `i < clients.length` (the batching
//   loop's bound) widened to `i <= clients.length` only ever adds one
//   extra iteration when `i` lands exactly on `clients.length`, at
//   which point `clients.slice(i, i+concurrency)` is provably `[]` (per
//   `Array.prototype.slice`'s spec), so `Promise.allSettled([].map(...))`
//   is a total no-op — checked across 7 (length, concurrency) pairs
//   including exact multiples, singletons, and the empty-clients case,
//   confirming byte-identical batch sequences between both operators in
//   every case.
//   traffic.ts (152 LOC — per-call traffic capture for the admin traffic
//   explorer + replay: recordTraffic/listTraffic/getTraffic/pruneTraffic
//   CRUD, opt-in globally + time-bounded by retention) 65 mutants,
//   58.46% baseline (38/65) -> 98.46% raw (64/65) across 2 verify
//   rounds -> effectively 100% (1 documented equivalent). Test dir
//   mirrors 1:1 (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. 27 baseline
//   survivors, small enough for direct authoring (no agent round) — one
//   new `traffic-mutation.test.ts`. Key findings:
//   - **`rowTo`'s `isError` boolean mapping was untested despite an
//     `errorsOnly` FILTER test existing** — the filter test only
//     checked the SQL-level row COUNT, never asserted `.isError` on a
//     returned record directly (same "half the fields are tested"
//     pattern as monitor.ts's `lastError` gap).
//   - **New equivalence class, a variant of the "downstream step
//     erases a fallback's own content" pattern**: `input.result.content
//     ?? []`'s fallback array mutated to Stryker's sentinel
//     `["Stryker was here"]` is unobservable, because the very next
//     step (`.map((c) => c.text ?? "")`) reads `.text` off each
//     element — a bare STRING has no `.text` property, so it maps to
//     `""` exactly like an empty array does, and `[""].join("\n")` is
//     `""` just like `[].join("\n")`. No downstream assertion on the
//     resulting preview text can ever distinguish the two fallback
//     values. Verified via a standalone scratch script across both
//     nullish inputs (undefined and null) before accepting.
//   - **A probabilistic-sampling boundary (`Math.random() < 0.02`)
//     needs the EXACT threshold value itself, not just one value on
//     each side.** An initial test used 0.5 (clearly not-sampled) and
//     0.01 (clearly sampled) — both agree with a `<=` mutant away from
//     the boundary, so neither distinguishes `<` from `<=`. Needed
//     `Math.random() === 0.02` exactly: real `<` excludes it (must NOT
//     fire), the `<=` mutant includes it (would wrongly fire). Same
//     "N-way boundary combination" lesson as rate-limiter.ts's sampled
//     log, generalized to a plain probabilistic-trigger guard.
//   - **`pruneTraffic()` is called as a same-module internal reference
//     from `recordTraffic`, so `spyOn` on the exported binding cannot
//     intercept the call** (ES module internal references bind
//     directly, not through the namespace object) — observed the
//     `Math.random()` gate's effect indirectly instead, by seeding a
//     stale row and checking whether it survives or gets deleted.
//   - **A cutoff-direction arithmetic mutant (`now - retentionMs` ->
//     `now + retentionMs`) needs the DEFAULT `now` value, not a
//     deliberately-extreme one.** The existing test forced `now` so far
//     into the future (to "prune everything") that BOTH the real
//     subtraction and the mutant's addition produced a cutoff far past
//     every row's timestamp — converging on the identical "prune
//     everything" result regardless of operator. Needed the real
//     current time as `now` instead: the real subtraction produces a
//     PAST cutoff (a just-inserted row survives), while the addition
//     mutant produces a FUTURE cutoff (would wrongly prune it) —
//     divergence only appears with a realistic, non-extreme `now`.
//   - **A test-only helper (`__clearTrafficForTesting`) had ZERO
//     coverage of its own**, despite being used throughout the existing
//     test suite's `beforeEach`/`afterEach` — its own correctness was
//     never itself verified.
//   tracing.ts (185 LOC — dependency-free OTLP/HTTP span export:
//   startSpan/endSpan, batching + deferred-flush scheduling, OTLP
//   payload construction, best-effort export via flush()) 92 mutants,
//   54.35% baseline (50/92) -> 94.57% raw (87/92) across 2 verify
//   rounds -> effectively 100% (5 documented equivalents). Test dir
//   mirrors 1:1 (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. 42 baseline
//   survivors, authored directly (no agent round). Key findings:
//   - **`setCurrentSpan`/`getCurrentSpan` are no-ops outside a real
//     `AsyncLocalStorage` run — a "bare" test call is silently vacuous
//     regardless of any mutation on the code that calls them.** An
//     initial attempt at testing endSpan's `if (!tracingEnabled())
//     return;` early-return (checking whether the current span stays
//     set vs. gets cleared) failed against REAL code because
//     `setCurrentSpan` no-ops when there's no ALS store — the whole
//     mechanism needed wrapping in `withTraceContext(...)` to actually
//     observe anything. Reusable lesson for any future test of
//     ALS-backed request-context state: a bare call proves nothing,
//     wrap it.
//   - **A `ConditionalExpression` mutant on an ALWAYS-true real-world
//     condition is a genuine equivalent for ONE direction only, not
//     both.** `if (t.unref) t.unref();` — a real Node/Bun `setTimeout`
//     return value always has a callable `.unref`, so forcing the
//     condition to always-`true` changes nothing (equivalent); forcing
//     it to always-`false` IS a real, killable gap (suppresses the
//     call entirely). Killed the `false` direction by spying directly
//     on the real timer's own `.unref` method (captured via a
//     `setTimeout` mock that still calls through to the real
//     implementation) rather than inferring it from process-lifecycle
//     side effects, which are otherwise unobservable inside a
//     synchronous test.
//   - **A same-line compound-boolean guard's TWO halves each need their
//     OWN distinguishing scenario, even when one test already flips
//     the `||`/`&&` operator itself.** `if (!endpoint || buffer.length
//     === 0) return;` — an "endpoint unset, buffer non-empty" test
//     kills the operator flip AND the first half's own
//     ConditionalExpression, but does NOT kill the SECOND half's own
//     ConditionalExpression-forced-false (`buffer.length === 0` forced
//     to never fire): with a configured endpoint and a genuinely EMPTY
//     buffer, that mutant would wrongly let `flush()` proceed to fetch
//     with nothing queued. Needed a distinct, complementary fixture
//     (endpoint SET + buffer EMPTY) to isolate it — verified this
//     precisely on the SECOND verify round after the first round's
//     dual-purpose test left this specific half unkilled.
//   5 documented equivalents: `genId` (a module-private helper with
//   ZERO real call sites anywhere in the codebase — confirmed via a
//   repo-wide grep — so its body is unreachable by construction); the
//   module-level `buffer`/`flushScheduled` initial values (the SAME
//   "DI-helper initial value unreachable once a resetting beforeEach
//   exists" class already seen on load-balancer.ts/quarantine.ts —
//   `_internalsForTesting.clear()`, called in every test file's own
//   beforeEach, truncates/reassigns both before the first assertion of
//   the first test ever runs); and the `t.unref` always-true direction
//   above.
//   trace-context.ts (188 LOC — W3C Trace Context: parseTraceparent/
//   formatTraceparent, newTraceId/newSpanId, the AsyncLocalStorage-backed
//   per-request context, outbound traceparent/tracestate propagation)
//   99 mutants, an already-strong 83.84% baseline (83/99, this file had
//   ~30 pre-existing tests covering most W3C spec edge cases) -> 93.94%
//   raw (93/99) across 2 verify rounds -> effectively 100% (4 documented
//   equivalents + 2 accepted timeouts). Test dir mirrors 1:1
//   (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. 14 baseline
//   survivors, authored directly (no agent round). Key findings:
//   - **The established "regex dual-technique" needed a THIRD variant
//     for anchor-removal specifically, distinct from character-class-
//     negation and quantifier-reduction.** All three of this file's
//     `^...{N}$`-shaped regexes (TRACE_ID_RE/SPAN_ID_RE/FLAGS_RE) had
//     both their `^` and `$` anchors survive — existing tests only
//     tried inputs SHORTER than the required length, which an
//     anchor-less regex still correctly rejects (nothing to match).
//     Needed inputs exactly ONE CHARACTER TOO LONG that still CONTAIN a
//     full valid run at the start or end — an anchored regex correctly
//     rejects these (the extra character makes an exact match
//     impossible), but an anchor-dropped one matches the embedded valid
//     substring anyway.
//   - **NEW equivalence-reasoning chain: an early guard can be masked by
//     the VERY NEXT guard for a specific input class, and that masking
//     can itself explain why chasing a "kill" for the early guard
//     always fails.** `if (value === "") return null;` (line 59) looked
//     like an easy, obviously-real gap — a whitespace-only input
//     reduces to `""` only after `.trim()`, a genuinely distinct path
//     from an already-empty string literal. But `"".split("-")` always
//     yields exactly `[""]` (a single-element array), so the VERY NEXT
//     guard, `if (parts.length < 4) return null;` (line 63, still real
//     when line 59 is the mutant under test), independently catches
//     every empty-value case anyway (`1 < 4` is always true). A test
//     that looked like it should kill line 59 was written, run, and
//     STILL failed to kill it on the verify round — re-investigating
//     (rather than assuming the test was buggy) revealed line 59 is
//     ALSO a genuine equivalent, for the exact same structural reason
//     already established for line 63's own mutant. General lesson:
//     when a seemingly-obvious new test doesn't kill its target mutant
//     on verify, check whether a DOWNSTREAM guard (not just an upstream
//     one) independently produces the identical outcome before assuming
//     the test itself is wrong.
//   4 documented equivalents total (59 x2, 63, 70) all trace to the SAME
//   underlying fact: every one of parseTraceparent's early guards for a
//   malformed/incomplete input is REDUNDANT with either the
//   `parts.length < 4` check or one of the three field-format regexes,
//   since an `undefined` destructured field or an empty split result
//   always fails a later check the same way. 2 accepted timeouts on
//   setCurrentSpan's ALS-guard (same "genuine Stryker timeout =
//   detected" convention as auth.ts/transports.ts/mcp-server.ts).
//   trace-store.ts (224 LOC — SQLite-persisted spans for the admin-UI
//   trace viewer: persistSpan, listTraces/getTrace/getTopSessions,
//   pruneSpans/purgeAllSpans) 62 mutants, 80.65% baseline (50/62) ->
//   **100.00% (62/62), clean** in a SINGLE verify round. Test dir
//   mirrors 1:1 (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. One new test
//   file, authored directly (12 baseline survivors — the SAME cluster
//   shapes already seen on this file's structural sibling, traffic.ts:
//   a type-check-vs-presence-check gap on two attribute-extraction
//   ternaries, an unasserted DB-write catch block, a probabilistic-
//   prune exact-boundary gap, a combined-filter " AND "-join gap, and a
//   test-only helper with zero coverage of its own). Reused the exact
//   same fixture techniques established for traffic.ts's own closing
//   pass (a non-string-but-present attribute value to distinguish
//   `typeof x === "string"` from a mere presence check; the exact
//   `Math.random() === 0.02` boundary; two simultaneous filter clauses
//   to exercise the join separator) — no NEW equivalence classes this
//   file, straight reuse of an established playbook start-to-finish.
//   usage.ts (224 LOC — proxy usage analytics: recordUsage,
//   getUsageSummary/getUsageTimeseries/getTopTools/getUsageByKey) 114
//   mutants, 53.51% baseline (61/114) -> 97.37% raw (111/114) across 2
//   verify rounds -> effectively 100% (3 documented equivalents). Test
//   dir mirrors 1:1 (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. 53 baseline
//   survivors — the largest solo-authored (no agent round) survivor
//   count this domain, but almost entirely mechanical/numeric-boundary
//   shapes rather than deep functional complexity, making a Workflow
//   unnecessary. One new test file, authored directly. Key findings:
//   - **A module-level counter with NO exported getter/reset helper,
//     observed only via a `% N === 0` sampling check, reproduces the
//     SAME `++`/`--`-direction equivalence already established for
//     rate-counters.ts's `opCount`** — `insertCount`'s prune-trigger
//     fires with identical frequency regardless of increment direction
//     (any N consecutive integers, ascending or descending, hit every
//     residue class mod N exactly once). Confirms this equivalence
//     CLASS (not just this one prior instance) generalizes to any
//     future unexported, un-resettable, modulo-gated counter.
//   - **Deterministically testing a "fires every Nth call" trigger
//     without a reset hook**: rather than trying to predict the exact
//     call index that crosses a multiple of 500 (impossible without
//     knowing the counter's current, cross-test-file-shared value),
//     called the function exactly 500 times in a row and asserted the
//     prune query fired EXACTLY once — deterministic regardless of the
//     counter's unknown starting offset, since any 500 consecutive
//     calls cross exactly one multiple of 500 no matter where they
//     start.
//   - **NEW equivalence class, a `GROUP BY` query's own SQL semantics
//     make a `calls > 0` guard partially redundant** — `getTopTools`'
//     `r.calls > 0 ? r.errors / r.calls : 0` looks identical to
//     `getUsageSummary`'s own `row.calls > 0` guard (same code shape),
//     but the two are NOT equally testable: `getUsageSummary` is a
//     plain aggregate that can genuinely return `calls = 0` for an
//     empty window, while `getTopTools` groups via `GROUP BY
//     client_name, tool_name` — SQL guarantees `COUNT(*) >= 1` for
//     every group actually emitted (a zero-member group is never
//     returned at all), so `r.calls > 0`/`r.calls >= 0`/forced-`true`
//     are ALL equivalent for any row this specific function can
//     produce, while the OPPOSITE-direction mutants (forced-`false`,
//     `<= 0`, the division-to-multiplication arithmetic) remain real,
//     killable gaps. General lesson: an IDENTICAL code shape appearing
//     in two different functions can have DIFFERENT equivalence
//     properties depending on how each function's own query produces
//     the value being checked — don't assume a pattern seen once
//     elsewhere transfers automatically; check the SPECIFIC query
//     shape (plain aggregate vs. GROUP BY) each time.
//   - **A limit-clamping ceiling test needs data that actually EXCEEDS
//     the ceiling to be observable** — an initial test asserted
//     `getUsageByKey({limit: 500}).length <= 200` after seeding only 3
//     keys, which passed under BOTH real code (clamps to 200) and the
//     mutant (no clamp at all) equally, since 3 rows is under 200
//     either way — a survivor on the SECOND verify round. Fixed by
//     seeding 201 distinct key ids (strictly more than the 200 cap)
//     and asserting the returned length is EXACTLY 200, not merely
//     "under some loose bound." Same "test with data safely under the
//     boundary can't distinguish clamped from unclamped" lesson
//     already seen elsewhere in this program, now confirmed to need
//     re-application even within domain 7 itself.
//   metrics.ts (322 LOC, the LARGEST domain-7 file and the last one —
//   a dependency-free Prometheus text-exposition-format implementation:
//   Counter/Gauge/Histogram/MetricsRegistry primitives, ~20 exported
//   metric constant declarations used throughout the codebase, and a
//   small "legacy JSON metrics" section for the older /metrics/legacy
//   route) 172 mutants, 48.84% baseline (85/172) -> 96.51% raw
//   (166/172) in a SINGLE verify round after the cold round ->
//   effectively 100% (4 documented equivalents + 2 accepted timeouts).
//   Test dir mirrors 1:1 (`src/observability/__tests__/`). Scope:
//   `STRYKER_TEST_SCOPE="src/observability/__tests__"`. Given the LARGE
//   survivor count (85, the largest in domain 7, comparable to
//   alerts.ts's 91), used a **4-agent parallel Workflow** (mc1: label
//   helpers + Counter + Gauge; mc2: Histogram + MetricsRegistry; mc3:
//   the ~20 metric constant declarations, via the bulk-schema-toEqual
//   technique; mc4: the legacy JSON metrics section, with genuinely
//   tricky module-state-with-no-reset-hook considerations), 26 tests
//   total across `metrics-mutation-{mc1..mc4}.test.ts`. All 4 agents
//   completed cleanly. A single verify round after the cold round
//   drove 48.84% -> 96.51% directly — but one manual fix was still
//   needed: mc4's initial design assumed a "pristine module state"
//   precondition (verified correct for the SCOPED Stryker run, since no
//   other file in src/observability/__tests__ touches this state
//   first) that broke the FULL `bun run test` gate (2 real failures),
//   since dozens of OTHER directories' tests call `recordToolCall` for
//   real via `proxyToolCall` before `src/observability` runs
//   alphabetically in a full-tree sweep. Key findings:
//   - **A Workflow agent correctly verified an assumption FOR ITS OWN
//     TEST SCOPE, but that scope was narrower than the full commit
//     gate — always re-verify against `bun run test` (the full suite),
//     not just the file's own scoped Stryker run, before treating a
//     module-state assumption as safe.** mc4's "must run before
//     anything else in this directory touches the state" reasoning was
//     genuinely correct for `STRYKER_TEST_SCOPE="src/observability/__tests__"`
//     (mc4's own file sorts alphabetically before the one other file
//     in that directory that calls `recordToolCall`), but the file-
//     discovery order across the ENTIRE `src/` tree in a full `bun run
//     test` invocation is different — many other directories'
//     proxy/mcp/middleware tests exercise `recordToolCall` for real via
//     `proxyToolCall` before `observability` ever runs alphabetically.
//     Fixed by removing the "pristine state" describe block entirely
//     and documenting its 3 targeted mutants (`latencies`'s initial
//     `[]` sentinel, and the `latencies.length > 0` guard's
//     forced-true/`>=0` variants) as equivalent-in-practice instead —
//     a genuinely-empty `latencies` array is not reliably observable
//     in ANY run that includes more than this one isolated file, given
//     no reset hook exists and real production code populates it
//     throughout the whole suite. The file's OTHER cluster (the
//     "latencies window cap", deliberately built to be robust to ANY
//     prior accumulated state via a flood-then-marker technique) needed
//     no changes at all and passed both scopes unmodified — the
//     general lesson: prefer a technique robust to unknown prior state
//     over one that assumes a specific execution order, even when the
//     order-dependent version happens to work in the narrower scope
//     you're immediately verifying against.
//   - **A near-identical "no reset hook, permanently touched by real
//     code elsewhere in the suite" module-state pattern recurred a
//     THIRD time in this one file** (after `getSessionCounts`'s default
//     arrow function, order-dependent on `src/mcp/transports.ts`'s
//     `setupTransports` being called elsewhere, and now `latencies`'s
//     empty-array precondition) — worth treating this as a standing
//     category to check for on any future un-resettable module-level
//     state, not a one-off surprise each time.
//
// ── DOMAIN 7 (src/observability, 10 of 10 files) COMPLETE: anomaly.ts,
// monitor.ts, alerts.ts, health.ts, traffic.ts, tracing.ts,
// trace-context.ts, trace-store.ts, usage.ts, metrics.ts — all
// effectively 100%. ──
//
// DOMAIN 8 = src/routes + src/routes/admin — IN PROGRESS. src/routes/
// has 28 files, src/routes/admin/ has 13 more (41 total). `admin.ts`
// and `src/routes/admin/admin-validators.ts` are both pure 1-line
// re-export barrels with no logic to mutate — SKIPPED, same
// "types.ts"-style precedent as domain 3. Test dir: `src/routes/__tests__/`
// (confirmed — holds routes-admin.test.ts, routes-alerts.test.ts,
// routes-auth.test.ts, etc.); `src/routes/admin/`'s own test location
// not yet confirmed for any file in that subdirectory — check before
// assuming when reaching one.
//   docs.ts (17 LOC — a NODE_ENV-conditional auth-guard selector
//   wrapping the Swagger UI mount at /docs: development mode bypasses
//   auth, everything else requires admin auth) 7 mutants, 0% baseline
//   (0/7 — ZERO test coverage of any kind existed before this) ->
//   **100.00% (7/7), clean** in a single verify round. Test dir
//   mirrors 1:1 (`src/routes/__tests__/`), new file
//   `routes-docs-mutation.test.ts` (no pre-existing `routes-docs.test.ts`
//   to extend). Scope: `STRYKER_TEST_SCOPE="src/routes/__tests__"`.
//   Authored directly (small file, no agent round). Real HTTP
//   integration tests (Express app + `listen(0)` + real fetch, same
//   pattern as the existing `routes-*.test.ts` files): NODE_ENV=
//   "development" bypasses auth entirely; any other value requires a
//   valid Bearer admin key; the route is genuinely mounted at exactly
//   `/docs` (an unrelated path 404s); and a real round-trip resolving
//   at all (not hanging) proves the dev-mode passthrough actually
//   calls `next()`.
//   validation.ts (34 LOC — almost entirely type declarations
//   (`ValidationResult`/`LooseValidationResult`) plus one tiny lookup
//   function, `mutationErrorToStatus`) 1 mutant, **100.00% (1/1),
//   ALREADY clean at baseline** — the single `mutationErrorToStatus`
//   BlockStatement mutant is killed indirectly by the many route test
//   files (oauth.ts, alerts.ts, bundles.ts, catalog.ts, and others)
//   that exercise its call sites through their own error-handling
//   paths. No new test file needed at all, no fix cycle — same
//   "not every file needs new work, always run baseline first"
//   precedent as domain 3's registry-alias-index.ts/tool-index.ts.
//   http-errors.ts (37 LOC — shared sendError/validationError/
//   notFound/forbidden error-envelope helpers + the requestId reader,
//   used by nearly every route file) 9 mutants, 22.22% baseline (2/9)
//   -> effectively 100% (5/9 killed + 4 accepted timeouts, 0 real
//   survivors) in a single verify round. Test dir mirrors 1:1
//   (`src/routes/__tests__/`), new file
//   `routes-http-errors-mutation.test.ts`. Authored directly (pure
//   functions operating on an Express `Response` — no real HTTP server
//   needed, just a minimal hand-rolled Response mock capturing
//   `.status()`/`.json()` calls, faster and simpler than the real-server
//   idiom every other `routes-*.test.ts` file uses). Closed:
//   `requestId()`'s `?? null` fallback (only observable with a real
//   truthy stored id, since `??` and `&&` agree whenever the left side
//   is falsy) and `validationError`'s exact `"VALIDATION_ERROR"` code
//   string. The 4 accepted timeouts are each one of
//   sendError/validationError/notFound/forbidden's own whole-body-
//   emptied mutant — emptying any of them returns `undefined` instead
//   of the chained `res.status().json()` Response, which would hang a
//   real HTTP-level caller waiting for a response that never gets
//   sent, so Stryker correctly times out rather than marking Killed
//   (same convention as auth.ts/transports.ts/mcp-server.ts elsewhere
//   in this program).
//   traces.ts (39 LOC — 4 admin-api endpoints: GET /admin-api/traces
//   list+filter, GET .../top-sessions, GET .../:traceId, DELETE
//   /admin-api/traces purge+audit) 41 mutants, 0% baseline (ZERO test
//   coverage existed) -> effectively 100% (40/41 killed + 1 accepted
//   timeout) after 3 iterations. Test dir mirrors 1:1
//   (`src/routes/__tests__/`), new file
//   `routes-traces-mutation.test.ts`. Two rounds of fixes: (1) the
//   `?tool`/`?session_id`/`?cursor` typeof-string guards' forced-true
//   direction needed Express's repeated-query-key => array behavior to
//   produce an observable divergence (a plain absent/present-string test
//   can't distinguish it); (2) the cursor guard's forced-false /
//   `typeof x === ""` direction survived a first pagination test that
//   only asserted `toHaveLength(1)` on page 2 — since silently dropping
//   the cursor just re-returns page 1's newest-first item at the same
//   length, the fix asserts page 2's item is a genuinely DIFFERENT
//   traceId than page 1's. The 1 accepted timeout is the GET-list
//   handler's own whole-body-emptied mutant (same "genuine Stryker
//   timeout = detected" convention as elsewhere in this program).
//   admin/connect.ts (15 LOC — single GET /connect/gateway-url
//   read-only helper reading config.gatewayPublicUrl ?? null) 4
//   mutants -> **100.00% (4/4), ALREADY clean at baseline** — the
//   pre-existing routes-connect.test.ts (73 LOC: requires-auth, unset
//   URL returns null, configured URL returned verbatim) already killed
//   every mutant. No new test file needed, no fix cycle — same
//   "not every file needs new work, always run baseline first"
//   precedent as validation.ts.
//   admin/monitors.ts (16 LOC — single GET /monitors read-only
//   dashboard-snapshot endpoint wrapping listMonitors()) 3 mutants, 0%
//   baseline (zero coverage existed) -> **100.00% (3/3), clean** in a
//   single verify round. Test dir mirrors 1:1
//   (`src/routes/__tests__/`), new file
//   `routes-monitors-mutation.test.ts`. Authored directly. Fixture
//   note: tool_monitor has NOT NULL example_id/baseline_schema_hash
//   columns plus an FK to tools(client_name, name) with
//   foreign_keys=ON — hand-rolled INSERT SQL isn't viable; reused the
//   REAL production helpers instead (registry.register() to create the
//   client+tool row, a tool_examples INSERT for the example, then the
//   actual exported setMonitor() to create the monitor row), matching
//   the fixture pattern already established in
//   src/admin/entities/__tests__/monitor.test.ts.
//   admin/overview.ts (39 LOC — GET /overview dashboard counters:
//   client status breakdown, disabled client/tool counts, circuit
//   breaker state counts, admin user count) 33 mutants, 36.36% baseline
//   (12/33) -> **100.00% (33/33), clean** in a single verify round.
//   routes-admin.test.ts already smoke-tested the happy path; new file
//   `routes-overview-mutation.test.ts` adds the missing coverage.
//   Two reusable techniques: (1) an ASYMMETRIC enabled/disabled split
//   (e.g. 1 enabled + 2 disabled) is required to kill a
//   negation-removal mutant (`!c.enabled` -> `c.enabled`) — a 1-vs-1
//   split can't distinguish it, since both directions yield the same
//   count. (2) circuit breaker open/half_open/closed counts read a
//   process-wide singleton shared with every concurrently-run test
//   file (never reset) — exact absolute counts aren't safe to assert,
//   so instead measured the DELTA around adding exactly one fresh
//   breaker of each kind (closed/open/half-open) within a single test,
//   safe under any pre-existing global state since bun:test runs
//   sequentially. This single delta test kills the entire cluster:
//   filter-strip/always-true mutants (closed-breaker delta would wrongly
//   move open/half_open), always-false/wrong-equality/emptied-string
//   mutants (open/half-open breaker delta would wrongly stay at 0), and
//   both ArithmeticOperator mutants on the closed computation (flipping
//   either `-` to `+` in `total - open - half_open` changes the closed
//   delta from the correct +1 to +3, since the open/half/total deltas
//   of 1/1/3 only cancel correctly under the original signs).
//   introspection.ts (41 LOC — GET /clients, GET /clients/:name/tools,
//   DELETE /clients/:name; each route guarded by adminAuth directly,
//   not via a shared router) 28 mutants, 0% baseline (zero coverage
//   existed) -> **100.00% (28/28), clean** in a single verify round.
//   Test dir mirrors 1:1 (`src/routes/__tests__/`), new file
//   `routes-introspection-mutation.test.ts`. Authored directly.
//   Standard real-HTTP + registry.register()/unregister() fixtures;
//   the DELETE handler's log() call was verified with a spyOn(loggerMod,
//   "log") assertion for the exact ("info", "Client unregistered", {
//   name }) arguments.
//   usage.ts (41 LOC — 4 read-only usage-analytics GET endpoints:
//   /admin-api/usage/summary, /timeseries, /top-tools, /by-key) 28
//   mutants, 57.14% baseline (16/28, existing routes-usage.test.ts
//   covered the happy path) -> effectively 100% (27/28, 1 accepted
//   equivalent) in a single verify round. New file
//   `routes-usage-mutation.test.ts` (existing file left untouched, same
//   "extend via a NEW -mutation file" convention as domain 7's
//   health/metrics split). One genuine equivalent, verified
//   empirically: the num() helper's `typeof v !== "string"` guard
//   forced always-false is unreachable-different, since Express's
//   default query parser only ever produces string/string[]/undefined
//   for req.query values, and Number() of any reachable string[]
//   (comma-joined via Array.prototype.toString()) or undefined is
//   always NaN — matching the early-return's `undefined` either way.
//   Two reusable techniques for the ?client= filter cluster (shared by
//   both /summary and /timeseries): an asymmetric 2-client fixture (one
//   client's calls narrowed out) kills the forced-false/emptied-string/
//   flipped-equality directions; a repeated-query-key array (same
//   technique as traces.ts) kills the forced-true direction, but via a
//   NEW discriminator worth generalizing — bun:sqlite throws
//   synchronously ("Binding expected string, TypedArray, boolean,
//   number, bigint or null", verified empirically) when a plain array
//   is bound as a query parameter, which Express's default error
//   handler turns into a 500; asserting the response STAYS 200 is
//   simpler than asserting a specific wrong-item-count the way
//   traces.ts's cursor tests had to.
//   tags.ts (44 LOC — GET /admin-api/tags, GET
//   /admin-api/tags/:tag/tools, PUT
//   /admin-api/clients/:name/tools/:tool/tags) 41 mutants, 65.85%
//   baseline (27/41, existing routes-tags.test.ts covered the happy
//   path + status-only checks for the 400/404 branches) -> **100.00%
//   (41/41), clean** in a single verify round. New file
//   `routes-tags-mutation.test.ts` (existing file left untouched). Key
//   technique: the `!Array.isArray(body.tags) || !body.tags.every((t)
//   => typeof t === "string")` validation guard has FIVE distinct
//   survivor mutants on one line (whole-condition-false, || -> &&,
//   .every -> .some, typeof-check-forced-true, if-block-emptied) — all
//   five collapse to the SAME observable failure mode: bypassing
//   validation lets a non-array or mixed-type tags value reach
//   .map(normalizeTag), where normalizeTag's .trim() throws on a
//   non-string element, crashing with a 500 instead of a clean 400.
//   Two fixtures (tags as a bare string; tags as ["real-string", 123])
//   killed all five at once by simply asserting the response STAYS a
//   clean 400 rather than crashing. Also added exact-body assertions
//   (message content, exact TOOL_NOT_FOUND envelope, exact { status,
//   name, tool, tags } success shape, exact recordAudit args) that the
//   pre-existing test never checked, only status codes.
//   admin/index.ts (51 LOC — top-level admin router: wires adminAuth
//   + mounts every per-entity sub-router under /admin-api) 2 mutants
//   -> **100.00% (2/2), ALREADY clean at baseline** — the many
//   `routes-admin.test.ts`/`routes-*.test.ts` tests that hit any
//   `/admin-api/...` path already exercise both the router-mounting
//   BlockStatement and the "/admin-api" StringLiteral indirectly. No
//   new test file needed, no fix cycle — same "not every file needs
//   new work" precedent as validation.ts/admin/connect.ts.
//   admin/canary.ts (54 LOC — GET/PUT /clients/:name/canary, per-client
//   secondary-upstream canary/failover config) 56 mutants, 0% baseline
//   (zero coverage existed) -> effectively 100% (55/56, 1 accepted
//   equivalent) after 2 verify rounds. Test dir mirrors 1:1
//   (`src/routes/__tests__/`), new file `routes-canary-mutation.test.ts`.
//   One genuine equivalent, verified empirically: the weight parser's
//   `typeof body.weight === "number"` guard forced always-true. Since
//   JSON.parse always deserializes a JSON numeric literal to a genuine
//   JS `number` (confirmed empirically), any non-number `body.weight`
//   fails `Number.isInteger(...)` identically whether or not the
//   typeof-guard defaults it to 0 first — both paths land on the same
//   INVALID_WEIGHT 400. First verify round missed the PUT handler's
//   OWN copy of the `!ensureClientAccess(...)` cross-team-denial guard
//   (the GET handler's copy was tested, but PUT has an independent
//   instance of the same guard on a different line) — fixed with a
//   second cross-team-denied-PUT test, closing to effectively 100% on
//   the second verify round. Heaviest reasoning of the file: several
//   `typeof x === "y" ? x : default` ternaries (secondaryBaseUrl, mode)
//   each needed TWO tests (a genuine value + an omitted/default value)
//   to cover both the "wrongly-defaults" and "wrongly-overrides"
//   directions; the `result.reason ?? result.error` fallback needed
//   both a no-reason error (CLIENT_NOT_FOUND) and a with-reason error
//   (INVALID_URL, via a syntactically-malformed URL string) to
//   distinguish `??` from a flipped `&&`.
//   admin/traffic.ts (55 LOC — GET /traffic list+filter, GET
//   /traffic/:id, POST /traffic/:id/replay via proxyToolCall) 47
//   mutants, 0% baseline (zero coverage existed) -> effectively 100%
//   (46/47 killed + 1 accepted timeout) after 2 verify rounds. New file
//   `routes-traffic-mutation.test.ts`. Same client/tool/cursor/limit
//   typeof-string-filter cluster shape as traces.ts, reusing its
//   established techniques (asymmetric narrowing + repeated-query-key
//   array). First verify round exposed a technique GAP: for the CURSOR
//   filter specifically, a non-string array doesn't crash bun:sqlite
//   the way client/tool do — `Number(nonStringValue)` coerces to a
//   valid (if useless) NaN BEFORE binding, so the "doesn't crash, stays
//   200" assertion used for client/tool is too weak here; the
//   forced-true mutant instead silently returns ZERO items (`id <
//   NaN` is always false in SQL) instead of real code's "cursor
//   ignored, return everything" — fixed by asserting the item COUNT,
//   not just the status. General lesson: **the "assert stays 200"
//   shortcut (established for usage.ts's client filter) only works
//   when the mutated value flows into a raw string-typed SQL bind
//   parameter; if it first passes through `Number(...)`, it always
//   converts to SOME valid bind value (even if NaN), so the divergence
//   shows up in the RESULT SET, not the status code — check what the
//   value flows into before picking a discriminator.** Also reused the
//   canary.ts "same guard, multiple call sites" lesson (GET /:id and
//   POST /:id/replay each have their own independent `!rec` guard) and
//   the "spy on proxyToolCall directly" technique (via
//   `spyOn(proxyMod, "proxyToolCall")`) to assert the replay endpoint's
//   exact parsed args, rather than mocking global fetch — simpler and
//   more precise than the fetch-mock idiom used in
//   src/observability/__tests__/traffic.test.ts, from which the
//   client/tool registration fixture pattern was reused.
//   register.ts (56 LOC — POST /register dispatch to REST/MCP/GraphQL
//   registration, GET /register/schema) 58 mutants, 50.00% baseline
//   (29/58, existing routes-register.test.ts is thorough for the
//   dispatch branches but never isolates individual OR-clauses, never
//   checks exact messages/request_id, never tests the tools[] cap AT
//   the boundary, and never touches GET /register/schema) ->
//   effectively 100% (50/58 real kills + 8 accepted: 1 timeout + 2
//   equivalents) after 2 verify rounds. New file
//   `routes-register-mutation.test.ts` (existing file left untouched).
//   Two genuine equivalents, one already-familiar shape and one new:
//   `req.socket?.remoteAddress`'s optional-chaining-removed mutant
//   (familiar "defensive check on an always-present property" shape,
//   matching http-errors.ts precedent) and — NEW — the GET
//   /register/schema 503-fallback branch's whole mutant cluster: it's
//   gated by `resolvedRegistrationSchema`, a MODULE-LEVEL CONSTANT
//   resolved once at import time from the repo's own checked-in OpenAPI
//   spec, with no `mock.module` precedent anywhere in this codebase to
//   force a load failure — verified empirically (`bun -e` import) that
//   it resolves non-null in this environment, making the whole
//   "unavailable" branch unreachable in any realistic test run here.
//   Fix-cycle miss on the first verify round: a request_id test
//   targeted register.ts's own Change-A guard (which calls
//   `validationError(res, message)` directly and never reads the LOCAL
//   `requestId` variable at all — it flows only into
//   performMcpRegistration/performGraphqlRegistration/
//   performRestRegistration as their 3rd argument), so it exercised the
//   wrong code path and left the `?? -> &&` mutant on that local
//   variable alive; fixed by re-targeting a registration-function
//   validation error instead. General lesson: **before writing a test
//   for "does variable X's fallback operator work", trace where X is
//   actually CONSUMED, not just where it's declared — a nearby-looking
//   error path in the same function may use a completely different
//   mechanism (its own `res.locals` read) that never touches X.**
//   admin/oauth.ts (64 LOC — GET/PUT /clients/:name/oauth, outbound
//   OAuth2 client-credentials config per upstream client) 57 mutants,
//   0% baseline (zero coverage existed) -> effectively 100% (54/57
//   killed + 3 accepted timeouts) after 2 verify rounds. New file
//   `routes-oauth-mutation.test.ts`. Structurally near-identical to
//   admin/canary.ts (same session) — GET/PUT + ensureClientAccess +
//   typeof-string-ternaries + a null-clear branch +
//   `result.reason ?? result.error` — so its whole test-design was
//   reused verbatim (asymmetric fixtures, per-ternary two-direction
//   tests, independent cross-team-denial tests for GET and PUT, no-
//   reason/with-reason fallback tests). One NEW empirically-verified
//   discriminator: the `scope` field's typeof-string ternary forced
//   always-true survived a first verify round because sending a
//   non-string `scope` (a number) doesn't crash — SQLite's STRICT
//   TEXT-column type coercion (verified via a throwaway `bun -e`
//   script: binding JS number `12345` to a STRICT `TEXT` column stores
//   the STRING `"12345"`, no throw) silently accepts it. Fixed by
//   asserting the persisted `scope` is `null` (real code's `undefined`
//   fallback) rather than the mutant's coerced `"12345"`, via a
//   follow-up GET. Setup fact worth remembering: the secrets provider
//   (`getSecretsProvider().isConfigured()`) is UNCONFIGURED by default
//   in this test env (`SECRET_ENCRYPTION_KEY` unset) — tests reaching
//   the encrypt-and-store success path must set
//   `config.secretEncryptionKey = Buffer.alloc(32, 7).toString("base64")`
//   first, matching `src/security/__tests__/oauth-mutation.test.ts`'s
//   own setup.
//   install-links.ts (66 LOC — public/unauthenticated GET
//   /install/:token: resolves a bundle install link, generates a
//   ready-to-use connect snippet) 29 mutants, 75.86% baseline (22/29,
//   existing routes-bundle-install-links.test.ts covers the valid/
//   unknown/revoked token happy paths but never varies
//   config.gatewayPublicUrl, never checks exact messages, never checks
//   the "bundle" scope/transport literals, never exercises a tool
//   missing from the live registry) -> effectively 100% (27/29 killed,
//   2 accepted equivalents) in a single verify round. New file
//   `routes-install-links-mutation.test.ts`. Two genuine equivalents:
//   the `${req.protocol}://localhost` no-Host-header fallback
//   (unreachable — HTTP/1.1 mandates a Host header, no real client can
//   omit it), and the tool-description `?? ""` fallback — proven
//   UNREACHABLE BY CONSTRUCTION via a schema-level argument, not just
//   an environmental one: `mcp_bundle_tools` has `FOREIGN KEY
//   (client_name, tool_name) REFERENCES tools(...) ON DELETE CASCADE`
//   with `foreign_keys=ON`, verified empirically with a throwaway
//   bun:sqlite script reproducing the schema (inserting a dangling
//   bundle_tools row throws "FOREIGN KEY constraint failed"; deleting
//   the underlying tool cascades to delete the bundle_tools row too,
//   confirmed via `registry.forgetClient()` making `bundle.tools`
//   become `[]` rather than a dangling reference) — so a bundle can
//   never contain a tool reference missing from `registry.listAllTools()`.
//   Also found and fixed a WRONG-METHOD mistake mid-session:
//   `registry.unregister()` only tears down the LIVE in-memory registry
//   entry and leaves the underlying `clients`/`tools` DB rows in place;
//   `registry.listAllTools()` reads those rows directly via SQL, so
//   `unregister()` alone never removes a tool from that map — only
//   `registry.forgetClient()` (which issues `DELETE FROM clients`,
//   cascading to `tools`) does. General lesson: **when a test needs a
//   client to be genuinely GONE from a live SQL-backed registry (not
//   just absent from an in-memory cache), check whether the registry
//   API distinguishes a "soft" teardown from a "hard" delete — this
//   codebase's registry has both (`unregister` vs `forgetClient`) and
//   they are NOT interchangeable for test fixture purposes.**
//   admin/audit-log.ts (68 LOC — GET /audit-log list+filter, GET
//   /audit-log/verify, GET /audit-log/actions, GET /audit-log/export
//   csv/html/json) 69 mutants, 59.42% baseline (41/69, existing
//   coverage in routes-admin.test.ts smoke-tests /audit-log and
//   thoroughly covers /export's format branches, but never varies
//   actor/action/from/to/cursor/limit on either list endpoint) ->
//   effectively 100% (67/69 real kills + 2 accepted timeouts) after
//   4 verify rounds. New file `routes-audit-log-mutation.test.ts`.
//   Same actor/action/from/to/cursor/limit typeof-string-filter
//   cluster shape as traces.ts/traffic.ts, applied identically twice
//   (the list endpoint's own copy AND the export endpoint's
//   independent copy of actor/action/from/to) — confirms the
//   "same guard, multiple call sites" lesson generalizes to filter
//   clusters, not just access guards. Two real gaps found across
//   rounds: (1) `GET /audit-log/verify` was completely untested (0
//   coverage of any kind) — missed entirely on the first pass despite
//   being a simple one-liner handler; (2) the export endpoint's
//   actor/action filters only had narrowing tests, not their sibling
//   "non-string doesn't crash" tests (the list endpoint's copies had
//   both, but coverage of one call site's full pair doesn't imply the
//   other call site got both either).
//   **NOTABLE: this file exhibited the most severe Stryker
//   verify-noise seen in this program to date** — TWO separate verify
//   rounds (the 3rd and 4th) reported the IDENTICAL 2 survivors
//   (40:12-37 / 41:13-39, the export actor/action ConditionalExpression
//   'true' mutants) even AFTER a real fix was applied and confirmed
//   passing via `bun test` directly. Resolved by manually hand-applying
//   each mutation to a local copy of the source (`sed -i` swapping
//   `typeof x === "string"` for a literal `true`) and running `bun test`
//   directly against it, TWICE — both times the test suite correctly
//   failed (proving the test WOULD kill the real mutant), yet Stryker's
//   own subprocess reported it as surviving. Root cause not
//   conclusively identified (suspected: worker-process reuse or some
//   state leak across sequentially-tested mutants within one Stryker
//   worker, since `concurrency` runs multiple mutants through a shared
//   pool of long-lived test-runner subprocesses) — but the manual
//   reproduction is definitive proof the test is correct. **General
//   lesson, stronger than the existing PX-2 precedent: when the SAME
//   survivor(s) persist across MULTIPLE consecutive verify rounds
//   despite a real, confirmed-correct fix, don't keep blindly re-running
//   Stryker — hand-apply the exact mutation to a backup-then-restore
//   copy of the source file and run the test suite directly. If the
//   test fails as expected, trust that signal over Stryker's report and
//   proceed to closure; re-running Stryker a 5th/6th time would not
//   have resolved this.**
//   admin/approvals.ts (73 LOC — GET /approvals status filter, POST
//   /approvals/:id/approve, POST /approvals/:id/reject) 67 mutants, 0%
//   baseline (zero coverage existed) -> effectively 100% (66/67 killed
//   + 1 accepted equivalent) after 2 verify rounds. New file
//   `routes-approvals-mutation.test.ts`. One genuine equivalent: the
//   `"approved"` string literal at the approve handler's
//   `decideApproval(rec.id, "approved", ...)` call site — confirmed by
//   reading `decideApproval`'s full body that its `status` parameter is
//   consumed in EXACTLY one place (`if (status === "rejected")`); every
//   other status-related SQL statement uses a hardcoded literal, never
//   the parameter, so `""` and `"approved"` are behaviorally identical
//   at this call site (both take the "not rejected" path). Key
//   technique: the tri-value status-filter OR (`q === "pending" ||
//   q === "approved" || q === "rejected"`) needed a MIXED 2-approval
//   fixture (one of the target status, one of a DIFFERENT status) for
//   each narrowing test — a single-approval fixture can't distinguish
//   "correctly filtered to 1" from "no filter applied, coincidentally
//   still 1" when only one approval exists at all. Also found: the
//   approve/reject handlers' `recordAudit` calls do NOT include the
//   `note` field in their detail objects (confirmed from source), so
//   the note-ternary's typeof-string guard had to be verified via a
//   follow-up `GET /approvals?status=...` read instead of the audit
//   spy technique used for canary.ts/oauth.ts's analogous ternaries —
//   check what the audit detail actually contains before assuming a
//   spy can observe a given field.
//   schedules.ts (74 LOC — GET /schedules list, POST /schedules create,
//   PATCH /schedules/:id toggle, DELETE /schedules/:id) 98 mutants, 0%
//   baseline (zero coverage existed within the scoped test run) -> 100%
//   (98/98 killed) after exactly 1 verify round. New file
//   `routes-schedules-mutation.test.ts`. Notable: `scheduleRoutes` is
//   wired directly in `server.ts`, NOT inside `adminRoutes()` like every
//   other domain-8 file this session — the test's `startApp()` had to
//   import and call `scheduleRoutes(app)` directly (plus
//   `requestIdMiddleware`, matching the existing
//   `src/admin/entities/__tests__/schedules.test.ts` app-wiring
//   pattern) instead of the usual `adminRoutes(app)`; the first test run
//   against an `adminRoutes(app)`-wired app 404'd on every request.
//   Key technique reused a 3rd time: killing a `typeof x === "string" ?
//   x : fallback` ternary's ConditionalExpression/EqualityOperator
//   mutants requires a TRUTHY NON-STRING value (e.g. a number), not
//   merely an absent/undefined one — an absent value is already falsy
//   both before and after a forced-true mutation, so it can't
//   distinguish the mutant from real code.
//   metrics.ts (84 LOC — GET /metrics Prometheus snapshot, GET
//   /metrics/legacy JSON) 60 mutants, 0% baseline (zero coverage
//   existed within the scoped test run) -> effectively 100% (59/60
//   killed + 1 accepted equivalent) after 2 verify rounds. New file
//   `routes-metrics-mutation.test.ts`. Also wired directly in
//   `server.ts`, not `adminRoutes()` (same as schedules.ts — now 2/2
//   domain-8 files outside `src/routes/admin/` following this
//   pattern). One genuine equivalent: `c.tools?.length` ->
//   `c.tools.length` (OptionalChaining) in the registryToolsTotal
//   reduce — `RegisteredClient.tools` (src/mcp/types.ts) is a
//   REQUIRED array field, never optional, at every construction site,
//   so the `?.` can never observably matter. Key techniques: (1)
//   reused `registry.markClientStatus(name, status)` — a real
//   production setter — to construct degraded/unreachable clients
//   directly, rather than raw SQL, since registry.register() always
//   creates "healthy" clients; (2) reused the delta-based-assertion
//   technique (domain 7's metrics.ts, domain 4's rate-limiter.ts) for
//   the two genuinely process-wide-singleton metrics this file reads
//   (rate-limiter bucket sizes, legacy tool-call counters) since those
//   are never reset between tests or files, while registry-derived
//   gauges could use exact/absolute assertions since `withApp`'s
//   per-test client cleanup keeps the registry itself isolated; (3) a
//   1-healthy/1-degraded fixture for the legacy endpoint's
//   `c.status === "healthy"` filter FAILED to kill its
//   EqualityOperator (`!==`) mutant — both real and mutant code
//   coincidentally count exactly 1 client (the healthy one vs. the
//   degraded one) — fixed with an ASYMMETRIC 2-healthy/1-degraded
//   fixture (same "mixed fixture" class as approvals.ts's tri-value
//   filter, but here the trap is a 1-vs-1 tie, not a single-item
//   fixture); (4) Bun's fetch/undici re-serializes Content-Type
//   parameter order, so a Content-Type assertion must check substrings
//   (`toContain`), not exact string equality, when the response sets
//   multiple `;`-separated parameters.
//   health.ts (87 LOC — GET /livez, GET /readyz, GET /health) 36
//   mutants, 0% baseline (zero coverage existed within the scoped
//   test run) -> effectively 100% (35/36 killed + 1 accepted
//   equivalent) after exactly 1 verify round. New file
//   `routes-health-mutation.test.ts`. Also wired directly in
//   `server.ts`, not `adminRoutes()` — all 3 routes are unauthenticated
//   (k8s/LB probes), so this file needed no admin-key/bearer setup at
//   all, unlike every other domain-8 file so far. One genuine
//   equivalent: `dbUp`'s `catch { return false; }` emptied to
//   `catch {}` — `dbUp()` has exactly one call site, `if (!dbUp())`,
//   which only ever consumes the return value through `!`; the real
//   `false` and the mutant's implicit `undefined` are both falsy, so
//   `!false`/`!undefined` are identically `true` for every input. Key
//   techniques: (1) reused the real `refreshLeaderStatus()` /
//   `__resetLeaderFlagForTesting()` production functions
//   (src/db/leader-lease.ts) to drive `isLeader()` deterministically,
//   rather than mocking it; (2) `spyOn(dbConnMod, "getDb")
//   .mockImplementation(() => { throw ... })` to simulate a DB outage
//   for `dbUp()`'s catch branch; (3) a combined
//   not-leader-AND-db-down test proves the two `if` guards are
//   independent/additive (both reasons appear, in order), not an
//   early-return that would only ever surface one; (4) the
//   `(Date.now() - startedAt) / 1000` arithmetic (`/`->`*` or
//   `-`->`+`) inflates the result from a small number of seconds to
//   the billions — a generous `toBeLessThan(86400)` bound catches both
//   without needing to control `Date.now()` directly or care about
//   module-load-order-dependent uptime values across a full suite run.
//   teams.ts (87 LOC — GET /admin-api/teams list, POST create, DELETE
//   /:id, PUT /admin-api/clients/:name/team, PUT
//   /admin-api/users/:username/team) 97 mutants, 0% baseline (zero
//   coverage existed within the scoped test run) -> **100% (97/97
//   killed)**, clean, after exactly 1 verify round. New file
//   `routes-teams-mutation.test.ts`. Also wired directly in
//   `server.ts`, not `adminRoutes()` (3rd domain-8 file following this
//   pattern). Gated by `requireSuperAdmin` (Bearer callers always
//   pass, same as `requireOperator`) — no new auth-fixture work
//   needed. Key techniques: (1) the POST handler's `body.name.trim()`
//   has a MethodExpression mutant dropping `.trim()` entirely — killed
//   with a name padded with leading/trailing whitespace, since the
//   UNTRIMMED raw string fails `ADMIN_ENTITY_NAME_RE`'s "must start
//   with alphanumeric" rule while the trimmed real value passes; (2)
//   both PUT routes share an IDENTICAL 3-way
//   `body.teamId === null ? null : (typeof body.teamId === "number" ?
//   body.teamId : undefined)` ternary — same "same guard, multiple
//   call sites" lesson as canary.ts/traffic.ts/audit-log.ts, each
//   route needed its OWN null-clear/number-assign/invalid-type/
//   unknown-target tests, four per route, eight total; (3) the
//   null-clear and number-assign tests are what distinguish the outer
//   `=== null` ternary branch's forced-true/forced-false directions
//   from each other (forced-true would null out a genuine numeric
//   assignment; forced-false would reject a genuine null as invalid).
//   backup.ts (98 LOC — POST /admin-api/backup: SQLite `VACUUM INTO` +
//   file stream + cleanup) 42 mutants, 0% baseline (zero coverage
//   existed within the scoped test run) -> **100% (42/42 killed)**,
//   clean, after 2 verify rounds. New file
//   `routes-backup-mutation.test.ts`. Also wired directly in
//   `server.ts`, not `adminRoutes()`. Gated by `requireAdminRole`
//   (Bearer callers always pass). First round left 4 survivors, all in
//   the unlink().catch() cleanup-failure log branch — no test forced
//   `unlink()` itself to fail; closed with a dedicated test spying
//   `fs/promises`'s `unlink` to reject. Key techniques, several new to
//   this program:
//   - **Pass-through `createReadStream` spy captures the exact path
//     under test without changing behavior**: `spyOn(fsMod,
//     "createReadStream").mockImplementation((p, opts) => {
//     capturedPath = String(p); return realCreateReadStream(p, opts);
//     })` (capturing `realCreateReadStream` BEFORE calling `spyOn`)
//     proves the private, non-exported `backupDir()` helper computed
//     the exact expected directory string for both its `?:` branches
//     (`dirname(config.dbPath)` normally, `process.cwd()` when
//     `config.dbPath === ":memory:"`, toggled by temporarily
//     overwriting `config.dbPath` for one test and restoring it after)
//     — without this, both branches are indistinguishable from the
//     outside since only a bare filename (not the full directory) is
//     ever echoed back to the client via `Content-Disposition`.
//   - **Real `VACUUM INTO` writes a real temp file to `./data/` during
//     tests** (not `:memory:` — `config.dbPath` has no test-env
//     override) — every test that doesn't hit this exact code path's
//     own cleanup must clean up its own leftover file by hand (`stat`-
//     failure and `unlink`-failure tests capture the real path from
//     their mock's own call argument and manually `unlink` it in
//     `finally`, using the real fs/promises `unlink` re-obtained after
//     `mockRestore()`).
//   - **A stream-`"close"`-triggered cleanup can resolve slightly
//     AFTER the client's `fetch()` sees the response as fully
//     received** — asserting file-non-existence immediately after
//     `await res.arrayBuffer()` was flaky; fixed with a short polling
//     helper (`waitForFileGone`, 20ms interval, 2s timeout) rather than
//     a single immediate check.
//   - **Simulating a post-headers-sent stream error requires pushing a
//     real data chunk before erroring**, since Express/Node only flush
//     headers on the first actual write. A custom `Readable` that
//     pushes one chunk then emits `"error"` on a later microtask
//     reliably gets past the `!res.headersSent` guard's "false"
//     branch, proving `res.destroy(err)` (not a second JSON response)
//     is what happens once the client has already received a 200. The
//     resulting connection-reset can surface as either the initial
//     `fetch()` call itself rejecting or a later body-read rejecting
//     depending on how much was buffered — the test accepts either by
//     wrapping the whole exchange in one try/catch rather than
//     asserting a specific rejection site.
//   admin/users.ts (105 LOC — GET/POST/PATCH/DELETE
//   /admin-api/users, mounted through `adminRoutes()` unlike the
//   previous 4 files) 114 mutants, 47.4% baseline (54/114 — the
//   pre-existing `routes-admin.test.ts` covers the create/list/delete
//   happy path, duplicate-username 409, last-admin-protected on
//   delete, last-admin-protected on demote-to-viewer PATCH, and
//   CAN-delete-when-another-admin-exists, but never asserts exact
//   codes/messages/audit details, never exercises PATCH's is_active
//   branch or its own last-admin guard, never tests an unknown
//   username on PATCH, and never verifies the username-trim/
//   role-default/type-coercion ternaries) -> effectively 100%
//   (112/114 killed + 2 genuine timeouts) after 2 verify rounds. New
//   file `routes-users-mutation.test.ts`, left `routes-admin.test.ts`
//   untouched. 2 accepted timeouts: the whole POST and PATCH handler
//   bodies emptied (`BlockStatement`) — an emptied async handler never
//   sends a response, so the request hangs until Stryker's own
//   per-mutant timeout, the same "genuine timeout = detected"
//   convention used throughout this program (auth.ts, transports.ts,
//   mcp-server.ts, ...). Round 1 left 2 real survivors that round-2
//   hand-verification confirmed were fixture design bugs, not
//   equivalents:
//   - **A `typeof x === "boolean" ? x : undefined` ternary's
//     forced-true mutant is NOT killed by sending a TRUTHY non-boolean
//     value** — `is_active: "true"` (a truthy string) passed through
//     `updateUser`'s `isActive ? 1 : 0` coercion lands on the SAME
//     active=1 outcome as the real "ignored, stays active" behavior,
//     by coincidence. Needed a FALSY non-boolean value (`is_active:
//     ""`) so the mutant's raw pass-through coerces to active=0 while
//     real code still ignores it and leaves the user active — a new,
//     narrower variant of the established "truthy non-string" lesson
//     (schedules.ts/metrics.ts/teams.ts): the fixture must specifically
//     be FALSY, not just non-boolean, when the downstream consumer
//     itself re-coerces via truthiness.
//   - **`nextRole !== undefined` forced-true inside a larger `&&`/`||`
//     chain can be masked by a SIBLING clause independently reaching
//     the same truth value** — a test sending `is_active: false` (no
//     `role` field) to protect a sole admin correctly expects 409, but
//     under this specific mutant the FORCED role-branch ALSO evaluates
//     true (`undefined !== "admin"` is true), so both real code (via
//     the genuine is_active branch) and the mutant (via the wrongly
//     forced role branch) independently arrive at the same 409 —
//     convergent-branch masking, not a genuine kill. Needed a request
//     that deliberately keeps EVERY real branch false (`is_active:
//     true`, no `role`) so only the mutant's forced branch would
//     wrongly fire.
//   upstream-auth.ts (111 LOC — GET/PUT/DELETE
//   /admin-api/clients/:name/upstream-auth, `validateBody`'s
//   bearer/basic/header switch) 159 mutants, 32.7% baseline (52/159 —
//   the pre-existing `routes-upstream-auth.test.ts` covers only the
//   bearer-auth happy path + a handful of 400/404/501/401/403 branches
//   at STATUS-CODE-ONLY level; it never exercises the basic-auth
//   branch AT ALL, never exercises bearer's own empty-token
//   validation, never exercises header auth's own happy path, and
//   never asserts exact codes/messages/audit details anywhere) ->
//   effectively 100% (157/159 killed + 1 accepted equivalent + 1
//   genuine timeout) after 2 verify rounds. New file
//   `routes-upstream-auth-mutation.test.ts`, existing file left
//   untouched. 1 accepted equivalent: the `input === null` half of
//   `typeof input !== "object" || input === null` — production mounts
//   `express.json({strict: true})` (src/server.ts), which rejects
//   every bare-scalar top-level JSON body (a raw string, `null`, a
//   number) with body-parser's own SyntaxError BEFORE the route ever
//   runs, confirmed empirically with a standalone script against a
//   real express app; there is no way to reach this handler with
//   `req.body === null` through the real HTTP boundary. 1 genuine
//   timeout: the whole PUT handler body emptied (same "hangs forever"
//   convention as auth.ts/admin/users.ts). Key findings:
//   - **`getUpstreamAuthInfo` (the read-model) never exposes the
//     stored secret, by design** — an `ObjectLiteral` mutant emptying
//     the `secret: {...}` object passed to `setUpstreamAuth` (for
//     bearer/basic/header alike) is INVISIBLE to any test that only
//     checks the read-model's `configured`/`type`/`headerName` fields
//     or that the raw plaintext doesn't leak. Had to import and call
//     `getUpstreamAuthHeaders(clientName)` directly (the function the
//     PROXY uses to resolve the real outbound `Authorization`/custom
//     header) to decrypt and reconstruct the actual stored credential
//     and assert it byte-for-byte — the only way to distinguish a
//     genuinely-stored secret from an emptied one from outside the
//     module.
//   - **A `typeof x !== "string" || x.length === 0` cluster needs an
//     EMPTY-STRING fixture, not just a MISSING-field fixture, to kill
//     the `.length === 0` sub-clause's forced-false direction** — an
//     omitted field is caught by the `typeof !== "string"` half
//     regardless of mutation, so it can never exercise the length
//     check on its own; needed `headerName: ""` / `value: ""`
//     specifically (both genuinely strings, both empty) as separate
//     fixtures from the missing-field ones.
//   - **A regex correctness test needs THREE fixture shapes, not one
//     positive case**, to fully kill an anchored `+`-quantified
//     character-class pattern's full mutant family: a normal
//     multi-char valid value (kills quantifier-removed and
//     negated-class mutants, both of which wrongly reject it); an
//     invalid LEADING character with an otherwise-valid suffix (kills
//     `^` removal, since `.test()` without a leading anchor still
//     matches the valid suffix); and an invalid TRAILING character
//     with an otherwise-valid prefix (kills `$` removal, symmetric
//     reasoning). One fixture shape alone leaves at least one anchor
//     direction unkilled.
//   - **A NEW test file that sets a shared config singleton
//     (`config.secretEncryptionKey`) must restore it via `afterEach`,
//     not just inside individual try/finally blocks** — the first
//     verify-round-2 full-suite run (`bun run test`) broke 3 UNRELATED
//     tests in other files (context-budget.ts's + admin-routes'
//     llm_summarize-secrets-provider tests) because this file's
//     `startApp()` unconditionally set the key on every call with no
//     global teardown, leaking a configured value into whatever test
//     file happened to run next in the same `bun test` process. Fixed
//     by capturing the ORIGINAL value once at module load and
//     restoring it in a top-level `afterEach`, matching the sibling
//     `routes-upstream-auth.test.ts` file's own established pattern —
//     always check a sibling test file for this exact convention
//     before introducing a new one that touches the same global.
//   admin/clients.ts (119 LOC — GET /clients list+filters, GET
//   /clients/:name detail, PATCH /clients/:name enabled+guards, DELETE
//   /clients/:name, PATCH /clients bulk enable/disable) 128 mutants,
//   46.1% baseline (59/128 — the pre-existing `routes-admin.test.ts`
//   covers the list/detail/PATCH/bulk-PATCH happy paths and a handful
//   of 404s at a basic level, but never exercises the query-filter
//   ternaries with a non-string fixture, never exercises team-scoped
//   cross-team denial on GET/PATCH/DELETE, never exercises the disable
//   branch's own audit action, and never asserts exact codes/messages/
//   audit details anywhere) -> effectively 100% (123/128 killed + 1
//   accepted equivalent + 4 genuine timeouts) after 2 verify rounds.
//   New file `routes-clients-mutation.test.ts`, existing file left
//   untouched. 1 accepted equivalent: the `teamId` ternary's
//   forced-true direction — `registry.listClientsSummary`'s own
//   query-building code re-validates `typeof opts.teamId === "number"`
//   before ever using it as a SQL filter param (confirmed by reading
//   the registry source directly), so whatever non-number value the
//   route passes through is treated identically downstream. 4 genuine
//   timeouts: the whole GET-list and PATCH-single handler bodies
//   emptied, plus PATCH's own `!ensureClientAccess(...)` guard's
//   negation-removed AND forced-true directions (both would either
//   fall through past an already-sent 404 response or return early
//   with NO response ever sent for a legitimately allowed request —
//   either way the connection hangs; same "hangs forever = detected"
//   convention as auth.ts/admin/users.ts/upstream-auth.ts). Key
//   findings:
//   - **A "doesn't crash" assertion on a query-filter ternary can't
//     distinguish real filtering from a forced-false/emptied-string
//     mutant that silently drops the filter** — both `status` and
//     `cursor`'s initial tests only checked that a non-string
//     (repeated-key) value didn't crash the request, which is
//     equally true whether the filter is genuinely applied-then-
//     ignored or unconditionally dropped. Fixed with a genuine
//     narrowing assertion for `status` (two clients with DIFFERENT
//     live statuses via `registry.markClientStatus`, filtered result
//     must exclude the non-matching one) and real 2-page pagination
//     for `cursor` (matching schedules.ts/audit-log.ts's established
//     cursor-pagination technique) — reconfirms that "positive value
//     passes through without crashing" is never sufficient for a
//     filter ternary; the test must prove the filter's OBSERVABLE
//     EFFECT.
//   - **Confirming a genuine equivalent requires reading the
//     downstream consumer's own validation code, not just reasoning
//     about the route in isolation** — the `teamId` ternary looked
//     identical in shape to `status`/`cursor` (same typeof-guard
//     pattern) but turned out equivalent specifically because
//     `registry.listClientsSummary` re-validates the SAME typeof
//     check before using the value, unlike `status`/`cursor` which
//     the registry consumes more directly. Same claim, same-looking
//     mutant, opposite conclusion — the deciding factor was reading
//     `src/mcp/registry.ts`'s actual query-building code, not
//     assuming symmetry with the other three filters.
//   consumers.ts (121 LOC — GET /consumers list, POST create, PATCH
//   /consumers/:id (name+monthlyQuota+endUserRateLimitPerMin), DELETE
//   /consumers/:id, GET /consumers/:id/usage) 125 mutants, 46.4%
//   baseline (58/125 — existing `routes-consumers.test.ts` covers
//   create/list/duplicate/usage/delete happy path and
//   endUserRateLimitPerMin validation+patch+null-clear, but never
//   PATCHes the `name` field at all, never tests an unknown id on
//   PATCH/DELETE/usage, and never asserts exact codes/messages/audit
//   details) -> effectively 100% (122/125 killed + 1 accepted
//   equivalent + 2 genuine timeouts) after 2 verify rounds. New file
//   `routes-consumers-mutation.test.ts`, existing file left untouched.
//   1 accepted equivalent: `optPositiveIntOrNull`'s `{ ok: false }`
//   emptied to `{}` — every call site consumes the result only through
//   `!x.ok`, and `!undefined`/`!false` are both `true` (same
//   equivalence class as several prior files' `{ok:false}`-shaped
//   helpers). 2 genuine timeouts: the whole POST and PATCH handler
//   bodies emptied (same "hangs forever" convention as prior files).
//   Key finding, round 1 left 2 real survivors on a THIRD verify
//   attempt-worthy gap that an UNPADDED no-op fixture couldn't reach:
//   - **A duplicate-name-on-update check with TWO separate `.trim()`
//     calls (`body.name.trim() !== existing.name && consumerNameExists(
//     body.name.trim())`) needs a WHITESPACE-PADDED fixture for EACH
//     call, not one unpadded "no-op" test** — PATCHing a name back to
//     its own CURRENT value with no padding can't distinguish either
//     `.trim()` mutant, since both sides already match without
//     trimming. Needed two separate fixtures: (1) a PADDED same-name
//     no-op (kills the FIRST `.trim()` — real code short-circuits the
//     `&&` to false before ever checking existence; the mutant's raw
//     untrimmed comparison wrongly differs, proceeds to check
//     existence, and finds the consumer's OWN row, since
//     `consumerNameExists` has no self-exclusion, wrongly 409ing), and
//     (2) a PADDED collision with a DIFFERENT consumer's real name
//     (kills the SECOND `.trim()` — this fixture keeps the first
//     clause genuinely true so the second clause actually runs; real
//     code trims before checking existence and correctly 409s, the
//     mutant checks the raw padded string that no consumer is
//     literally named, wrongly letting the rename through). General
//     lesson: when TWO trim/normalize calls guard the SAME compound
//     condition, a fixture proving one is reachable doesn't prove the
//     other is exercised — each needs its own padding-sensitive case,
//     and the SECOND one specifically needs the FIRST clause to
//     independently evaluate true so the second clause is even reached.
//   admin/lb.ts (123 LOC — GET/PUT /clients/:name/lb strategy config,
//   POST /clients/:name/lb/upstreams add target, PATCH/DELETE
//   /clients/:name/lb/upstreams/:id) 123 mutants, 0% baseline (zero
//   coverage existed at all — confirmed via grep across every
//   __tests__ dir) -> effectively 100% (114/123 killed + 9 genuine
//   timeouts) after 1 verify round (a SECOND round was needed only
//   because the first was sleep-contaminated mid-run — see below, not
//   because of a real test gap). New file `routes-lb-mutation.test.ts`.
//   9 genuine timeouts, all whole-handler-emptied
//   (GET/PUT/POST — 3 of the file's 5 routes) or their OWN
//   `ensureClientAccess` guard's negation-removed/forced-true
//   directions (same "hangs forever = detected" convention as every
//   prior domain-8 file); PATCH's and DELETE's structurally-identical
//   copies of the SAME guard were cleanly killed (not timeouts) by
//   this file's own tests — worth noting that 5 structurally identical
//   guards in the same file don't necessarily all time out the same
//   way, so don't assume a clean kill on one call site predicts the
//   outcome on a sibling.
//   **OPERATIONAL INCIDENT this file — sleep contamination recurred,
//   confirming the DOMAIN 2-era gotcha is still live and this session
//   had NOT been running a keep-awake guard for any of today's earlier
//   domain-8 verify rounds.** The first verify attempt's log showed
//   elapsed time jump from `~4m` to `~2h 32m` between consecutive
//   progress lines, with the timed-out-mutant count spiking from 6 to
//   14 in the same jump — both signs matched the documented "machine
//   suspends overnight, Stryker's wall-clock elapsed counts sleep time"
//   pattern exactly. Fixed by `taskkill /PID <root> /T /F` on the
//   contaminated process tree (confirmed via `Get-Process`), clearing
//   the orphaned `.stryker-tmp/sandbox-*` left behind, and relaunching
//   with an EXPLICIT keep-awake guard this time
//   (`SetThreadExecutionState([uint32]0x80000001L)` before
//   `Wait-Process`, released with `0x80000000L` after) — the re-run's
//   elapsed-time progression stayed linear (no further jumps) and
//   finished in a normal ~9 minutes. **Going forward for the rest of
//   this domain-8/9/10 program: always pair every Stryker verify/
//   baseline launch with the keep-awake guard in the SAME background
//   PowerShell call as the `Wait-Process`, not as a separate step that
//   can be silently skipped** — this session had drifted away from
//   that discipline for several files before this incident surfaced it.
//
//   config-io.ts (145 LOC — GET /config/export (JSON/YAML),
//   POST /config/import (JSON/YAML, dry-run/real), and the full
//   snapshots subsystem: GET list, POST create, GET/:id, DELETE/:id,
//   GET/:id/diff, POST/:id/rollback) 129 mutants, 13.95% baseline
//   (18/129 killed by the existing hand-written routes-config-io.test.ts,
//   which only covers plain-JSON export/import happy paths) -> **100%
//   (129/129), clean** after 2 verify rounds. New file
//   `routes-config-io-mutation.test.ts`, existing test file left
//   untouched (only gap-filled). Round 1 left exactly 1 survivor: the
//   `body.format === "yaml"` sub-condition (mutant 21) forced-true —
//   none of the existing fixtures distinguished it because every
//   format:yaml test ALSO had format genuinely equal to "yaml" (forcing
//   the clause true changes nothing when it's already true), and the
//   only format-omitted test used a non-string `raw`. Closed with a
//   fixture where format is OMITTED but `raw` IS a string alongside an
//   invalid-version `data` — real code takes the `else` branch (uses
//   `data`, 400s on the bad version) while the forced-true mutant
//   wrongly takes the YAML branch and parses `raw` (a valid document)
//   for a 200. Key findings:
//   - **A whole snapshots subsystem (list/create/get/delete/diff/
//     rollback) had zero coverage of any kind** despite being fully
//     wired and reachable — always check EVERY route in a file actually
//     has at least one test, not just the ones the existing hand-written
//     file happened to cover.
//   - **`recordAudit`'s detail objects use `.length`, not the array
//     itself** for skip counts (`{ applied, skipped: result.skipped.length
//     }`) on both the import and rollback routes — an initial
//     `toHaveBeenCalledWith(..., { skipped: [] })` assertion failed with
//     a clear array-vs-number diff; always check the exact shape being
//     passed to recordAudit rather than assuming it mirrors the
//     underlying result type.
//   - Reused the established "call the real entity function directly to
//     verify a route's effect" technique (`getConsumerByName`/
//     `createConsumer`/`deleteConsumer` from admin/entities/consumers.ts)
//     to prove a non-dry-run import/rollback genuinely persisted, not
//     just that the response looked right.
//   - **The PowerShell `-RedirectStandardOutput`/`-RedirectStandardError`
//     Start-Process params silently captured ZERO bytes** for a `bunx
//     stryker run` launch — the process completed successfully (exit 0,
//     result.json freshly written) but with empty logs, and the
//     resulting survivor list was suspiciously IDENTICAL to the prior
//     baseline scan. Root cause never fully confirmed, but switching to
//     `Start-Process -FilePath cmd.exe -ArgumentList '/c','bunx stryker
//     run > log 2>&1'` (redirection handled by cmd.exe itself before
//     exec'ing the bunx shim, not by PowerShell capturing a grandchild's
//     handles) produced normal, actively-advancing progress output on
//     the very next attempt. **New standing rule: always verify a
//     Stryker run's progress log is non-empty and advancing (check
//     during the run, not just after) before trusting its result —
//     an empty log + a suspiciously-unchanged survivor count is a red
//     flag that the run didn't do what it claimed.**
//
//   `policies.ts` (160 LOC — guard-policy CRUD: GET list, POST create,
//   PATCH update, DELETE, POST /:id/apply to tools or a bundle) 196
//   mutants, 0% baseline within scope (the existing hand-written
//   routes-policies.test.ts covered POST create/duplicate-409/list/
//   delete happy paths, the tools-array apply path, and a blanket 401
//   — but PATCH had ZERO coverage of any kind) -> 95.9% (188/196
//   killed), 5 confirmed equivalents, 3 accepted timeouts (whole-
//   handler-emptied) after 2 verify rounds — effectively 100%, zero
//   unexplained gaps. New file `routes-policies-mutation.test.ts`,
//   existing test file left untouched. First file closed via the new
//   parallel Workflow (see PARALLELIZATION note above) — authored,
//   verified, and full-suite-checked entirely inside an isolated git
//   worktree, then integrated back by hand. Key findings:
//   - **New equivalence class: a `LooseValidationResult`-shaped
//     `{ ok: false }` return site mutates cleanly to `{}` and stays
//     equivalent whenever EVERY consumer only checks `.ok` via `!`
//     truthiness** (never a strict `=== false` comparison, never reads
//     `.value` off the falsy branch) — `{}.ok` is `undefined`, exactly
//     as falsy as `false`. Recurred 3 times in this one file alone
//     (optPositiveOrNull's and validateToolRefs' `{ok:false}` sites);
//     worth checking on any other file using the same convention
//     (src/routes/validation.ts) before assuming such a mutant is a
//     real gap.
//   - **`JSON.stringify(Infinity)` silently serializes to `null`**,
//     which is itself a VALID value for an `optPositiveOrNull`-shaped
//     field — genuinely testing a non-finite-number rejection path
//     requires bypassing `JSON.stringify` and sending a raw body
//     string with a numeric literal that overflows on parse (e.g.
//     `1e400`), since `JSON.parse('1e400') === Infinity` but the
//     literal itself is syntactically valid JSON.
//   - Reconfirmed the two-`.trim()`-calls-in-one-condition technique
//     (first seen on consumers.ts) needs TWO distinct padded fixtures
//     on `body.name.trim() !== existing.name && policyNameExists(...)`
//     -shaped lines — one padded same-name no-op, one padded collision
//     with a DIFFERENT row's name.
//   - **Worktree-specific environment gotcha, unrelated to this file**:
//     a fresh git worktree lacks the untracked `data/` directory
//     (needed by routes-backup-mutation.test.ts's real VACUUM INTO
//     tests) and, separately, had 9 pre-existing test failures
//     (config-schema.test.ts, registration-mutation-rg1.test.ts,
//     routes-register-mutation.test.ts) reproducible with or without
//     this file's own changes — confirmed unrelated and worktree-only
//     (the MAIN repo's full suite stayed green after integration).
//     Narrowed `STRYKER_TEST_SCOPE` to just the 2 policies-related test
//     files for the actual mutation runs rather than the whole
//     `src/routes/__tests__` directory, which is safe per this
//     project's own documented invariant (fewer tests can only leave a
//     mutant undetected, never falsely mark one killed).
//
//   **PARALLELIZATION (2026-07-10): the remaining domain-8 tail (12
//   files: alerts.ts through admin-validators.ts) is being closed via
//   a Workflow that fans out one worktree-isolated agent per file,
//   batched 3-at-a-time (matched to this machine's 16 physical/32
//   logical cores — Stryker's own internal `concurrency: 8` per run
//   means 3 concurrent files already uses 24 threads; going wider
//   risks corrupting Stryker's own 60s per-mutant timeout heuristic
//   under contention, which would misreport real survivors as
//   false-positive timeouts). Each agent does the full baseline/
//   author/verify/full-suite cycle in its own worktree and returns a
//   structured result (test file content + score + findings); a
//   single steward (this conversation) does the actual git integration
//   serially afterward — writing the file into the main repo, a
//   sanity full-suite run, then the usual stryker.config.mjs/
//   CHANGELOG.md/commit/memory housekeeping — to keep one commit per
//   file and avoid every agent's local edits to this shared file
//   conflicting with each other. Files close in COMPLETION order, not
//   strictly the original smallest-LOC-first queue order, since
//   parallel agents finish at different times regardless of their
//   file's size. **New gotcha found integrating the first parallel
//   result (policies.ts): a git worktree checked out under
//   `.claude/worktrees/` (used by every parallel agent) is NOT swept
//   by `.gitignore` when running plain `eslint .` — ESLint walks the
//   filesystem directly and doesn't consult .gitignore at all, so a
//   live worktree's own full `src/` copy gets treated as a SECOND
//   tsconfig root, producing thousands of spurious tsconfigRootDir/
//   parsing errors across the entire real codebase (same root cause,
//   different directory, as the earlier `.stryker-tmp/sandbox-*`
//   incident below). Fixed PERMANENTLY this time (rather than just
//   deleting the offending directory) by adding an explicit
//   `.claude/**` entry to `eslint.config.js`'s top-level `ignores`
//   array — safe to run `bun run lint` from the main repo even while
//   other worktrees are still live and in progress.**
//
//   `auth.ts` (153 LOC — admin login/logout, GET /me, PATCH
//   /me/password, GET /sessions, DELETE /sessions/:id) 188 mutants,
//   23% baseline (43/188 killed — the existing hand-written test
//   covered only login's happy/sad paths, GET /me's session branch,
//   and logout's CSRF gate; PATCH /me/password, GET /sessions, and
//   DELETE /sessions/:id were entirely untested) -> effectively 100%
//   (176/188 killed, 11 confirmed equivalents, 1 accepted timeout)
//   after 2 verify rounds. New file `routes-auth-mutation.test.ts`,
//   existing test file left untouched. Second file closed via the
//   parallel Workflow. Key findings:
//   - **New equivalence class, confirmed by hand-mutating and
//     re-running the suite for all 5 occurrences**: an identical
//     3-clause session-context guard (`!ctx || ctx.method !== "session"
//     || <ctx.username|ctx.userId undefined>`) repeats verbatim across
//     3 routes (PATCH /me/password, GET /sessions, DELETE
//     /sessions/:id); forcing the middle clause to a literal `false`
//     is equivalent at every site because `AuthContext`'s own shape
//     ties `method === "session"` to always carrying a real
//     username/userId — whenever the third clause could differ, the
//     middle clause's real value already agrees with the forced one,
//     and whenever it wouldn't agree, the third clause independently
//     produces the same outcome either way.
//   - `.catch(() => false)`'s arrow body mutated to `() => undefined`
//     is equivalent at both its call sites (login, password-change) —
//     the caught value only ever feeds a `!x` boolean check, and
//     `undefined`/`false` are equally falsy there.
//   - **New mechanical technique**: for holdout equivalence
//     candidates, wrote a small script that patches the EXACT Stryker
//     mutant text into a backup-restorable copy of the source by
//     1-indexed line:column (Stryker's own convention), then ran the
//     real test pair directly — much faster per-mutant than a full
//     Stryker verify round when confirming a handful of candidates.
//     Gotcha hit building it: invoking a native Windows node/bun
//     executable directly with a git-bash-style `/c/Users/...` path
//     silently mangles into a bogus path or drops segments — always
//     use `C:/Users/...` (drive-letter + forward slashes) for a
//     directly-invoked native Windows executable from this
//     environment.
//   - **New sequencing technique**: reaching `Bun.password.verify()`'s
//     throw path for a route gated behind an active session (which
//     itself depends on the SAME credential store) requires seeding a
//     clean login first, then corrupting the stored hash AFTER
//     authentication succeeds — corrupting it up front breaks the
//     login step itself.
//   - **`GET /sessions` touches the authenticating cookie's own
//     `last_seen_at`** (a sliding-window side effect) — naively
//     listing then deleting `sessions[0]` can silently target the
//     CALLING cookie's own session (freshly touched, sorts first), not
//     the intended other one; fixed by tagging each login with a
//     distinct User-Agent and reading identity via the real
//     `listActiveSessionsForUser` entity function directly, bypassing
//     the HTTP endpoint's own side effect.
//   - Confirmed (again) that `STRYKER_TEST_SCOPE="src/routes/__tests__"`
//     (the whole directory) has pre-existing, unrelated dry-run-
//     blocking failures — narrowed to the two auth-specific test files
//     for this file's own runs, same as policies.ts.
//
//   `alerts.ts` (152 LOC — GET/POST /alerts, PATCH/DELETE
//   /alerts/:id, POST /alerts/:id/test) 170 mutants, 40% baseline
//   (68/170 killed — existing hand-written test covered create/list/
//   patch/delete happy path, invalid-eventType/non-http-webhook 400s,
//   the test-endpoint's happy-path delivery, and a blanket 401, but
//   never PATCH's own 404, DELETE's 404, POST /test's 404 or failure
//   path, any exact message/audit assertion, or the isEventType/
//   isHttpUrl/optNumber helper clusters) -> effectively 100%
//   (165/170 killed, 3 confirmed equivalents, 2 accepted timeouts)
//   after 1 verify round (plus a second confirming round). New file
//   `routes-alerts-mutation.test.ts`, existing test file left
//   untouched. **Handled SOLO, not via the parallel Workflow**: this
//   file's own worktree agent (`wf_034df3d5-691-1`) got stuck — its
//   background Stryker process silently died mid-run (last progress
//   line at 34%/58 mutants, ~52 minutes with zero further output, no
//   matching process found in the OS process list) while other
//   worktrees' agents kept progressing normally, so its own
//   `parallel()` promise never resolved. Since the baseline scan had
//   already been captured before the stuck agent hung (170 mutants,
//   68/170 killed, full survivor list preserved), this file was
//   authored and verified directly in the main repo instead of
//   waiting indefinitely. 3 confirmed equivalents, verified by
//   hand-mutating the source and re-running the full suite for each:
//   - `isEventType`'s `typeof v === "string"` clause forced true —
//     `ALERT_EVENT_TYPES.includes(v)` can only ever be true when `v`
//     genuinely IS one of those string literals, at which point the
//     typeof clause is independently already true; no non-string
//     input can make `.includes(v)` true, so the mutant is
//     unreachable.
//   - `optNumber`'s `typeof v === "number"` clause forced true — same
//     `Number.isFinite()` non-coercive equivalence class seen
//     repeatedly across this program (P2-2, policies.ts): it returns
//     false for any non-number regardless of what the typeof clause
//     evaluates to.
//   - `optNumber`'s final `return { ok: false }` emptied to `{}` —
//     same `LooseValidationResult` `{ok:false}`->`{}` class confirmed
//     on policies.ts: every consumer only checks `.ok` via `!`
//     truthiness, and `{}.ok` is `undefined`, exactly as falsy as
//     `false`.
//   A genuinely REAL, closely-related mutant (`isHttpUrl`'s OWN
//   `typeof v === "string"` clause forced true) is NOT equivalent,
//   unlike its isEventType sibling: `v.startsWith(...)` throws a
//   TypeError for a non-string `v` (unlike `.includes()`, which is
//   type-safe), so a non-string webhookUrl must be proven to still
//   400 gracefully rather than 500/crash — worth remembering that two
//   superficially identical "typeof-then-a-string-method-or-check"
//   guards can differ in equivalence depending on whether the SECOND
//   half of the check throws or safely returns false for a non-string
//   input.
//
//   `ws-proxy-admin.ts` (170 LOC — GET list/detail, POST create,
//   PATCH update, DELETE, POST /disconnect-all for the persistent-
//   WS-proxy target registry) 161 mutants, 0% baseline (no test file
//   existed at all — the sibling `routes-ws-proxy.test.ts` only
//   covers `ws-proxy.ts`'s actual WS upgrade/pipe logic via a raw
//   `server.on("upgrade")` harness, never mounting these admin CRUD
//   routes) -> effectively 100% (156/161 killed, 4 confirmed
//   equivalents, 1 accepted timeout) after 1 verify round. New file
//   `routes-ws-proxy-admin-mutation.test.ts`. Third file closed via
//   the parallel Workflow. 3 of the 4 equivalents are the SAME
//   `Number.isInteger`-short-circuit class already documented for
//   tool-search.ts (domain 3): a `typeof x !== "number" || ...`
//   guard's first clause is redundant whenever the second clause is
//   `!Number.isInteger(x)`, since `Number.isInteger` is spec-mandated
//   to return false for any non-Number type regardless of what typeof
//   evaluates to — recurred at 3 independent call sites
//   (maxConnections/maxMessageBytes/idleTimeoutMs) in this one file.
//   The 4th is a StringLiteral-fallback equivalence (an invalid-name
//   fallback value is only ever consumed by a regex validator that
//   rejects both the real "" and the mutant's marker string
//   identically). **Integration-time fix, found while sanity-checking
//   in the main repo (not caught by the agent's own worktree run,
//   which lacked a dev `.env`)**: one test asserting a blocked-private-
//   IP-range rejection relied on the AMBIENT `config.allowPrivateIps`
//   defaulting to false, which is only true in a bare environment —
//   this repo's own local dev `.env` sets `ALLOW_PRIVATE_IPS=true`
//   (needed to register real loopback test clients, per CLAUDE.md),
//   so the same test PASSED in the sandboxed worktree (no `.env`) but
//   FAILED in the main repo (real dev `.env` present) with the
//   registration wrongly succeeding (201) instead of being blocked
//   (400). Fixed by explicitly forcing `config.allowPrivateIps =
//   false` for the duration of that one test (save/restore), rather
//   than relying on whatever the ambient environment happens to
//   default to — any future test asserting SSRF-block behavior
//   specifically (as opposed to tests that merely NEED private IPs
//   permitted, which already use this same save/restore pattern
//   elsewhere in this file) must do the same.
//
//   `discovery.ts` (199 LOC — POST /discovery/preview (OpenAPI/
//   curl/Postman/manual sources) and POST /discovery/preview-graphql)
//   164 mutants, 54% baseline (89/164 killed by the existing
//   routes-discovery.test.ts) -> effectively 100% (149/164 killed, 6
//   confirmed equivalents, 9 accepted timeouts) after 2 verify rounds.
//   New file `routes-discovery-mutation.test.ts`, existing test file
//   left untouched. Fourth file closed via the parallel Workflow. 9
//   accepted timeouts, the largest count so far for a single file in
//   domain 8 — mostly whole-handler/whole-branch-body-emptied mutants
//   across the file's 2 routes and their several source-specific
//   try-blocks (openapi_url / curl-postman / manual), plus a
//   validateManualToolsForPreview negation-removed/forced-true pair
//   that both reach the exact same "early-return with no response
//   sent yet" hang. 6 confirmed equivalents (all hand-mutation
//   verified): a `stringArray()` ternary whose empty-vs-undefined
//   distinction is erased by every caller's own `?.length`/`?? []`
//   truthiness check; 2 validator-branch `return false`->`return true`
//   flips that only cause a benign double-send-after-flush (the
//   FIRST, correct response already reached the client before the
//   second one throws `ERR_HTTP_HEADERS_SENT` server-side); a
//   non-string-fallback StringLiteral consumed only by a hardcoded-
//   message URL-prefix guard that rejects both fallback values
//   identically; and a `new URL(...).pathname || "/graphql"` fallback
//   — the same "WHATWG URL.pathname is never falsy" equivalence class
//   already documented for registration.ts (domain 3). A rate-limiter
//   singleton collision (the shared "register" tier bucket, keyed only
//   by caller IP) required clearing `_internalsForTesting.registerBuckets`
//   in `afterEach`, not just at setup, to avoid a stale 429 leaking
//   from this file's own tests into the sibling test file's later
//   runs. **Reported (honestly) `fullSuitePassed: false`** at hand-off
//   — the SAME pre-existing worktree-only environment artifacts as
//   policies.ts/auth.ts (config-schema.test.ts x5,
//   registration-mutation-rg1.test.ts x3), confirmed unrelated via
//   isolation + `git diff` showing zero changes to those files; the
//   MAIN repo's full suite stayed green (3492/3492) after integration,
//   confirming (yet again) that this exact 8-9-failure signature is a
//   worktree-environment artifact specific to this parallel-Workflow
//   program, not a real regression — safe to disregard once
//   re-verified against the main repo directly.
//
//   `catalog.ts` (204 LOC — catalog-entry CRUD: GET list, POST
//   create, PATCH update, DELETE, POST /:id/install) 270 mutants,
//   35% baseline (95/270 killed) -> effectively 100% (265/270
//   killed, 2 confirmed equivalents, 3 accepted timeouts) after 1
//   verify round. New file `routes-catalog-mutation.test.ts`, existing
//   test file left untouched. Fifth file closed via the parallel
//   Workflow (from batch 3, alongside admin/tools.ts and
//   auth-oidc.ts). 2 confirmed equivalents (both hand-mutation
//   verified): `stringArrayOrUndefined`'s `v === undefined` early
//   return is dead code since every real call site already guards
//   behind its own `if (body.X !== undefined)` check; and
//   `req.socket?.remoteAddress`'s `?.` is redundant since Node's http
//   server always populates `req.socket` before Express ever
//   dispatches to a handler (same class as auth.ts's identical
//   finding). 3 accepted timeouts (whole-handler-emptied, standard
//   convention) on create/PATCH/install — notably, the analogous
//   whole-body-emptied mutant on the DELETE handler was instead
//   cleanly KILLED rather than timing out, apparently because a
//   pending-connection interaction fires a bun-internal timeout
//   faster than Stryker's own 60s external one — a stronger, not
//   weaker, detection signal, so this asymmetry needed no action.
//
//   `auth-oidc.ts` (214 LOC — OIDC SSO: GET /start, GET /callback,
//   GET/PUT /settings) 186 mutants, 50% baseline (93/186 killed) ->
//   effectively 100% (176/186 killed, 5 confirmed equivalents, 5
//   accepted timeouts) after 2 verify rounds. New file
//   `routes-auth-oidc-mutation.test.ts`, existing test file left
//   untouched. Sixth file closed via the parallel Workflow (last of
//   batch 3, alongside admin/tools.ts and catalog.ts). 5 accepted
//   timeouts, all whole-handler/whole-helper-body-emptied (including
//   `redirectToLoginWithError()`, a shared helper called from 11
//   different failure branches across the callback handler — emptying
//   it hangs every one of them). 5 confirmed equivalents (all
//   hand-mutation verified): 2 StringLiteral fallback-value mutants
//   (issuer/redirectUri "" -> "Stryker was here!") where the downstream
//   protocol-prefix regex check rejects BOTH values identically; 2
//   more where the route's own `.trim()`/default-literal for `scopes`
//   is fully masked by `setOidcConfig`'s OWN internal
//   `.trim() || "openid profile email"` re-application, so the
//   route-level default/trim never actually reaches storage
//   unchanged; and the by-now-familiar `req.socket?.remoteAddress`
//   optional-chaining removal (same class as auth.ts/catalog.ts —
//   Express's `req.socket` is never null for a real HTTP connection).
//   **New permanent lint fix, found integrating this file**: the SAME
//   ESLint-doesn't-consult-.gitignore root cause as the `.claude/**`
//   fix (policies.ts) also applies to `.stryker-tmp/sandbox-*` — a
//   Stryker run's own live sandbox copy, mid-execution, got swept
//   into `bun run lint` as a second tsconfig root (963 spurious
//   errors) when lint happened to run while a DIFFERENT solo Stryker
//   verify (composites.ts) was still executing concurrently. Instead
//   of the old workaround (wait for the sandbox to disappear, or
//   delete an orphaned one), added `.stryker-tmp/**` to
//   `eslint.config.js`'s `ignores` array permanently, alongside
//   `.claude/**` — `bun run lint` is now safe to run at ANY time,
//   even mid-Stryker-run, going forward.
//
//   `composites.ts` (176 LOC — composite-tool CRUD: GET list/detail,
//   POST create, PATCH update, DELETE) 175 mutants, 0% baseline (no
//   test file existed at all) -> effectively 100% (169/175 killed, 3
//   confirmed equivalents, 3 accepted timeouts) after 2 verify rounds.
//   New file `routes-composites-mutation.test.ts`. Seventh file
//   closed via the parallel Workflow, but its OWN verify round never
//   finished within that agent's turn budget (interrupted at 22%,
//   40/175 tested) — completed SOLO afterward instead of waiting
//   indefinitely, same as alerts.ts. **Also required a genuine retry**:
//   the first solo attempt was launched while 3 OTHER parallel-
//   workflow agents (batch 3) were simultaneously running their own
//   Stryker scans, causing severe resource contention (26 concurrent
//   Stryker-related processes observed) that corrupted the timeout
//   heuristic — 24/40 mutants (60%!) falsely timed out, an order of
//   magnitude above this program's normal 1-9-per-file rate. Killed
//   the contaminated run, cleared the orphaned `.stryker-tmp/sandbox-*`
//   it left behind, waited for a window with 0 active Stryker
//   processes (confirmed via `Get-CimInstance Win32_Process`), and
//   re-ran cleanly (0-3 timeouts throughout). **New standing rule for
//   the rest of this parallel-workflow program: before launching any
//   SOLO Stryker run to pick up an interrupted/stuck parallel agent's
//   work, check the Stryker-related process count first and wait for
//   a low-contention window** — don't just fire it alongside whatever
//   the parallel workflow's other agents happen to be doing. 3
//   confirmed equivalents (hand-mutation verified): the `typeof e !==
//   "object"` step-shape guard is masked by the SAME step's own
//   targetClient/targetTool typeof checks (every JSON-reachable
//   non-object value's property access yields `undefined`, which
//   those checks independently reject); the `tmpl === null` check is
//   literally dead code since `e.argsTemplate ?? {}` already excludes
//   null via nullish coalescing before this line ever runs; and the
//   name fallback `""` -> marker-string StringLiteral is masked by
//   `TOOL_NAME_RE` rejecting both identically (same class as
//   ws-proxy-admin.ts/bundles.ts). One genuine gap: the 10KB
//   `argsTemplate` size check's `>` vs `>=` boundary needed an EXACT
//   `JSON.stringify(tmpl).length === 10240` fixture (accepted under
//   real `>`, wrongly rejected under the mutant `>=`) — the existing
//   under/over fixtures only tested well clear of the boundary.
//   Picked up a genuinely useful permanent fix along the way: the
//   worktree agent had patched `scripts/stryker-test-runner.ts` to
//   `mkdirSync("data", {recursive:true})` before every scoped run
//   (the gitignored `./data/` directory routes/backup.ts's real
//   `VACUUM INTO` tests need doesn't exist in a totally fresh
//   worktree/sandbox) — merged into the main repo permanently rather
//   than left as a one-off worktree patch.
//
//   `mcp-keys.ts` (273 LOC — MCP API key CRUD: GET list, POST create,
//   PATCH update, DELETE, POST /:id/rotate) 319 mutants, 49% baseline
//   (157/319 killed) -> effectively 100% (315/319 killed, 2 confirmed
//   equivalents, 2 accepted timeouts) after 3 verify rounds. New file
//   `routes-mcp-keys-mutation.test.ts`, existing test file left
//   untouched. Eighth file closed via the parallel Workflow. 2
//   confirmed equivalents are the by-now-familiar
//   typeof-then-Number.isInteger/isFinite short-circuit class
//   (validateConsumerId, validateExpiresAt) — recurring for the 4th+
//   time in this domain (ws-proxy-admin.ts, tool-search.ts lineage).
//
//   `bundles.ts` (305 LOC — MCP bundle CRUD: GET list/detail, POST
//   create, PATCH update, POST /install-links) 255 mutants, 47%
//   baseline (121/255 killed) -> effectively 100% (248/255 killed, 3
//   confirmed equivalents, 4 accepted timeouts) after 2 verify
//   rounds. New file `routes-bundles-mutation.test.ts`, existing test
//   file left untouched. Ninth file closed via the parallel Workflow.
//   3 confirmed equivalents: the SAME TOOL_NAME_RE-masks-fallback-
//   marker class (bundle-name StringLiteral) and the SAME
//   typeof-then-Number.isFinite short-circuit class
//   (validateExpiresAt) seen repeatedly this domain, plus a THIRD
//   recurring class — `typeof entry !== "object"` masked by
//   validateToolRefs' own downstream `.client`/`.tool` typeof checks
//   (identical mechanism to composites.ts's step-shape equivalent,
//   confirmed independently on a different file's own copy of the
//   same validation idiom).
//
//   `admin-validators.ts` (457 LOC, the LARGEST file in domain 8 —
//   13 exported `validate*Input(raw: unknown): ValidationResult<T>`
//   pure-function helpers consumed by src/admin/tool-policies/
//   mutations/*.ts and admin/clients.ts; NO Express routes, NO DB
//   access, NO recordAudit calls) 1027 mutants, 0% baseline (no test
//   file existed) -> effectively 100% (1014/1027 killed, 13 confirmed
//   equivalents, 0 accepted timeouts) after 2 verify rounds. New file
//   `routes-admin-validators-mutation.test.ts`, tested via direct
//   import+call (no Express/supertest harness needed at all — same
//   idiom as http-errors.ts's pure-function precedent, but scaled up
//   to 13 functions). Tenth file closed via the parallel Workflow, and
//   by far the largest single mutant count this program has directly
//   authored tests for in one file. All 13 confirmed equivalents are
//   the SAME "masked by a strict-type-checking builtin" class seen
//   throughout domain 8 (`Number.isInteger`/`Number.isFinite`/
//   `Array.prototype.includes` each independently reject any wrong
//   type regardless of what a preceding `typeof` clause evaluates
//   to) — confirmed by hand-mutating and re-running the FULL 93-test
//   file for every single one individually (not assumed from pattern-
//   matching alone), since it recurs across 5 different validators in
//   this one file. **Important counter-example documented alongside**:
//   the SAME typeof-ternary shape feeding into a plain falsy-check
//   (`if (!crp || !cp)`) instead of a strict builtin is NOT
//   equivalent — a truthy non-string value slips through a falsy
//   check silently, so distinguishing needs a wrong-type-but-TRUTHY
//   fixture (e.g. a number), not just a value-fidelity check. Also:
//   an `.every()` -> `.some()` MethodExpression mutant needed a MIXED
//   valid+invalid array (a single-bad-entry array can't distinguish
//   them), and a `.slice(0, N)` message-truncation mutant needed a
//   fixture deliberately longer than N characters.
//
//   `admin/tools.ts` (202 LOC — per-tool policy PATCH (delegates to
//   `dispatchToolMutations`), bulk enable/disable, synthetic test
//   call, saved-example CRUD, circuit-breaker reset, cache purge,
//   quarantine clear) 166 mutants, 0% baseline within scope (no test
//   file existed) -> effectively 100% (158/166 killed, 5 confirmed
//   equivalents, 3 accepted timeouts) after 1 verify round, using the
//   EXISTING test file the parallel Workflow agent had already
//   authored (38 tests) with ZERO further changes needed — every one
//   of the 5 raw survivors turned out to be a genuine equivalent, not
//   a real gap. Eleventh and LAST file of domain 8, closed solo after
//   its own parallel-Workflow verify round was interrupted at 9%
//   (16/166 tested). **Self-inflicted process gotcha, worth
//   remembering**: the FIRST solo attempt to complete this file was
//   launched WITHOUT first writing the agent's already-authored test
//   file to disk — an oversight (the file's content had been reviewed
//   from the journal but the `fs.writeFileSync` step was skipped,
//   unlike every other file this session). Running Stryker with zero
//   new test coverage in place produced a 90% survival rate (107/119
//   tested) that superficially LOOKED like the same resource-
//   contention corruption seen on composites.ts — but with 0 timeouts
//   (contamination always shows up as spurious TIMEOUTS, never
//   spurious survivors), which was the tell that something else was
//   wrong. Diagnosed by checking whether the test file even existed
//   on disk (`ls src/routes/__tests__/ | grep tools` — it didn't),
//   killed the wasted run, wrote the file for real, and re-ran
//   cleanly. **New standing rule: immediately after reviewing ANY
//   parallel-Workflow agent's structured result, write its
//   `newTestFileContent` to disk via `fs.writeFileSync` in the SAME
//   step — never defer it, and never launch a Stryker run for a file
//   without first confirming (via `ls`) that its test file actually
//   exists on disk.** 5 confirmed equivalents (all hand-mutation
//   verified): the compound `typeof body !== "object" || body ===
//   null || Array.isArray(body)` guard's first two clauses are BOTH
//   individually and jointly unreachable — `body === null` can never
//   be true since `(req.body as ...) ?? {}` already replaces
//   null/undefined with `{}` before this line runs (same class as
//   composites.ts's `tmpl === null`), and `typeof body !== "object"`
//   can never independently matter since Express's `express.json()`
//   defaults to `strict: true`, which rejects any raw top-level JSON
//   scalar (string/number/boolean) with its own 400 SyntaxError
//   BEFORE the route ever executes — confirmed empirically with a
//   standalone probe, not assumed — leaving only genuine objects and
//   arrays reachable, and `Array.isArray(body)` already independently
//   catches the latter. Plus a 5th: `outcome !== null` forced false
//   is the SAME double-send-after-flush equivalence class as
//   discovery.ts's validator-branch flips — the dispatcher's FIRST
//   (correct) error response already reaches the client before the
//   mutant's redundant second `res.json()` call throws
//   `ERR_HTTP_HEADERS_SENT` server-side.
//
// **── DOMAIN 8 (src/routes + src/routes/admin, 41 files) COMPLETE
// (2026-07-10) ──** Final roster: docs.ts, validation.ts,
// http-errors.ts, traces.ts, admin/connect.ts, admin/monitors.ts,
// admin/overview.ts, introspection.ts, usage.ts, tags.ts,
// admin/index.ts, admin/canary.ts, admin/traffic.ts, register.ts,
// admin/oauth.ts, install-links.ts, admin/audit-log.ts,
// admin/approvals.ts, schedules.ts, metrics.ts, health.ts, teams.ts,
// backup.ts, admin/users.ts, upstream-auth.ts, admin/clients.ts,
// consumers.ts, admin/lb.ts, config-io.ts, policies.ts, auth.ts,
// alerts.ts, ws-proxy-admin.ts, discovery.ts, catalog.ts,
// auth-oidc.ts, composites.ts, mcp-keys.ts, bundles.ts,
// admin-validators.ts, admin/tools.ts (41 files; 2 barrel re-exports
// confirmed skipped, not counted). Every file effectively 100%. The
// last 12 files (alerts.ts onward) closed via a worktree-isolated
// parallel Workflow, batched 3-at-a-time — 9 of 12 completed cleanly
// end-to-end by their own agent, 3 needed solo rescue (alerts.ts: a
// stuck agent whose Stryker process died silently; composites.ts and
// admin/tools.ts: interrupted mid-verify, ran out of turn budget).
// See the PARALLELIZATION note above and each file's own entry for
// the full set of gotchas this approach surfaced (Stryker-process-
// contention corrupts the timeout heuristic; ESLint doesn't consult
// .gitignore for either `.claude/worktrees/` or `.stryker-tmp/`; a
// dev `.env`'s `ALLOW_PRIVATE_IPS=true` diverges from a fresh
// worktree's default; always write an agent's test file to disk
// immediately, never defer it).
//
// Next: domain 9 = src/admin (33 files: src/admin/tool-policies/
// mutations/*.ts [18 small ToolMutation handlers, 19-116 LOC each,
// zero test coverage], src/admin/config/*.ts [3 files, zero test
// coverage], src/admin/audit/*.ts [2 files, only audit-chain.test.ts
// exists — likely a different file], src/admin/entities/*.ts [9
// files, several ALREADY have substantial test coverage: alerts,
// anomaly, approvals, consumers, monitor, policies, rbac, schedules,
// teams], src/admin/tool-composition/*.ts [3 files, bundles.ts and
// composites.ts already have tests, bundle-install-links.ts doesn't]).
// Test dirs mirror source subdirectories 1:1 (src/admin/audit/
// __tests__/, src/admin/entities/__tests__/,
// src/admin/tool-composition/__tests__/) — EXCEPT src/admin/config/
// and src/admin/tool-policies/mutations/ have no __tests__ dir at
// all yet. Given many domain-9 files are called directly by already-
// tested domain-8 routes, expect higher baseline scores than domain 8
// saw from indirect coverage alone. The 18 tiny mutations/*.ts files
// are candidates for batching (same reasoning as domain 4's "8 small
// remaining files" batch) rather than 18 separate closures.
//
//   src/admin/entities/policies.ts (112 LOC — guard-policy CRUD + bulk
//   apply-to-tools/apply-to-bundle logic backing the domain-8
//   src/routes/policies.ts handlers) 47 mutants, 97.9% baseline (46/47
//   killed — the existing policies.test.ts only covered the CRUD happy
//   path + apply success/skip/unknown-bundle cases, leaving
//   getGuardPolicy()/policyNameExists() completely untested) -> **100%**
//   (47/47) in 1 verify round. New file
//   src/admin/entities/__tests__/policies-mutation.test.ts. Direct
//   import+call (plain-function entity module, no Express routes, no
//   recordAudit calls of its own). Closed via a worktree-isolated
//   parallel Workflow agent.
//   src/admin/config/config-diff.ts (59 LOC — pure order-insensitive
//   structural diff between two config documents, name-keyed array
//   alignment) 75 mutants, 93.3% baseline (70/75, no prior test file
//   existed at all) -> effectively 100% (72/75 + 3 accepted equivalents)
//   in 1 verify round. New dir + file
//   src/admin/config/__tests__/config-diff-mutation.test.ts. The 2 real
//   gaps were both in walk()'s aIsObj/bIsObj null guards (`typeof null
//   === "object"` in JS makes the `x !== null` conjunct load-bearing —
//   without it a null leaf vs. a real object wrongly falls through to
//   `Object.keys(null)` and throws instead of reporting a clean
//   'changed' diff). 3 accepted equivalents, all hand-verified: the
//   array-transform's `arr.length > 0` boundary (unobservable — an empty
//   array's `.every()` is vacuously true, so sorting a no-op empty array
//   either way is indistinguishable) in both its ConditionalExpression
//   and EqualityOperator (`>= 0`) forms, and walk()'s top-level `a ===
//   b` early-return (provably redundant — every input satisfying it is
//   independently caught by either the JSON.stringify shortcut or the
//   self-referential recursive walk one level down). Also notable: the
//   array sort-alignment tests needed a 3-element asymmetric fixture
//   (deliberately unsorted going in) since a naive 2-element swap can't
//   distinguish a correct ascending sort from a reversed one. Closed via
//   a worktree-isolated parallel Workflow agent.
//   src/admin/entities/teams.ts (112 LOC — team multi-tenancy entity:
//   CRUD on teams, client/user team-ownership assignment, and the
//   canAccessClient scoping decision) 70 mutants, 80% baseline (56/70 —
//   the existing teams.test.ts covered the route-enforcement/happy-path
//   side but left getTeam() completely untested, plus the
//   setClientTeam/setUserTeam "clear" and "unknown-teamId" branches and
//   the admin_users side of the FK ON DELETE SET NULL cascade) ->
//   **94.3%** (66/70 + 4 accepted equivalents) in 1 verify round. New
//   file src/admin/entities/__tests__/teams-mutation.test.ts. The 4
//   accepted equivalents (2 ConditionalExpression existence-guard
//   disables + 2 EqualityOperator `>0`->`>=0` boundary mutants, one pair
//   each in setClientTeam/setUserTeam) are all hand-verified: each
//   guard's existence check is followed immediately (same synchronous
//   call, no interleaving I/O) by an UPDATE keyed on the same PRIMARY
//   KEY/UNIQUE column the guard just checked, so the guard's own
//   return-false path and the UPDATE's own `.changes` count always
//   agree. No recordAudit calls exist in this file, unlike most
//   domain-8 route handlers. Closed via a worktree-isolated parallel
//   Workflow agent.
//   src/admin/config/config-versions.ts (114 LOC — snapshot CRUD
//   (create/list/get/delete) + diff/rollback on top of config-io.ts's
//   exportConfig/importConfig) 39 mutants, 100% baseline (39/39, stable
//   across 2 verify rounds) — no dedicated domain-9-convention test file
//   existed yet (a pre-existing sibling src/__tests__/config-versions.
//   test.ts covering the happy paths was left untouched), so the first
//   draft doubled as the baseline per this program's own contingency
//   for an empty __tests__ dir. New file src/admin/config/__tests__/
//   config-versions-mutation.test.ts. Zero equivalents or timeouts
//   needed. Closed via a worktree-isolated parallel Workflow agent.
//   src/admin/entities/consumers.ts (159 LOC — API-consumer CRUD +
//   monthlyQuota/endUserRateLimitPerMin enforcement checked on the
//   proxy hot path) 89 mutants, 57.3% baseline (51/89 — the existing
//   consumers.test.ts drove CRUD/FK-set-null/proxy-integration paths
//   thoroughly but never imported isValidQuotaValue, consumerNameExists,
//   or getConsumerByName at all, and only ever called
//   checkConsumerQuota/checkEndUserRateLimit with the optional
//   `consumer` param omitted) -> effectively 100% (88/89 + 1 accepted
//   equivalent) in 1 verify round. New file src/admin/entities/
//   __tests__/consumers-mutation.test.ts (direct-call, no Express routes
//   of its own). Notable techniques: bun:sqlite's loose type-affinity
//   binding means ordinary non-integer ids (1.5, NaN, strings) can't
//   kill getConsumer's `!Number.isInteger(id)` guard at all (both paths
//   return null) — passing the boolean `true` (silently coerced to 1 by
//   sqlite) against a real id-1 row is the fixture that actually
//   distinguishes guard-present from guard-removed; the optional
//   explicit-`consumer` param on checkConsumerQuota/checkEndUserRateLimit
//   needed a fabricated Consumer object paired with a non-existent
//   consumerId to prove the passed object (not a fresh getConsumer()
//   lookup) is what's used; the 256-char end-user-id truncation was
//   killed with two ids sharing an identical 256-char prefix that
//   diverge only after it. The 1 accepted equivalent (isValidQuotaValue's
//   `typeof v === "number"` forced to `true` inside its `&&` chain) is
//   the same Number.isInteger-implies-typeof-number equivalence class
//   documented throughout this program. Closed via a worktree-isolated
//   parallel Workflow agent.
//
//   src/admin/tool-policies/mutations/ (18 ToolMutation handlers +
//   index.ts's dispatcher; types.ts excluded) — closed as ONE batch, per
//   the domain-4 "8 small files" precedent. Baseline: 553 mutants, 35
//   killed (5.3%, only indirect exercise from src/routes/admin/tools.ts's
//   own PATCH tests, which only ever send `{ enabled: ... }`) ->
//   effectively 100% (504/553 raw, all 49 remaining raw survivors
//   confirmed equivalent) after 3 verify rounds. New file
//   src/admin/tool-policies/mutations/__tests__/mutations-batch.test.ts,
//   76 tests, tested via direct calls to `dispatchToolMutations` (no
//   Express app needed — a lightweight mock Response captures
//   status/json calls). Two recurring equivalence classes account for
//   the bulk of survivors: (1) each handler's OWN `ok ? {kind:"ok"} :
//   {kind:"tool_not_found"}` (or `{kind:"error"}`) ternary has its
//   SUCCESS branch (`{kind:"ok"}` emptied to `{}`) survive in EVERY one
//   of the 18 files, since the dispatcher only ever branches on
//   `result.kind === "tool_not_found"` / `"error"`, never checking for
//   `"ok"` explicitly — confirmed via hand-mutation on cache.ts, then
//   applied identically to all 18 (each file needed its OWN
//   `expectToolNotFound` test since each has a separate AST copy of the
//   ternary, but none needed a corresponding "ok" test); (2) several
//   `{kind:"set"}` discriminant string literals (monitor.ts, graphql.ts,
//   ws.ts) survive emptied to `""` since nothing ever checks
//   `kind==="set"`, only `kind==="clear"`. Real gaps closed per-file:
//   monitor.ts (INVALID_INTERVAL 400 path, `monitor: false` clear
//   trigger, intervalMinutes default-15), graphql.ts/ws.ts (non-object
//   non-array raw values beyond just arrays, non-string-truthy required
//   fields), overrides.ts (its own `{kind:"ok"}` gap; the
//   TOOL_ALIAS_INVALID 400 branch of its status ternary is a confirmed
//   DEAD branch — validateToolOverrideInput's displayName regex is
//   IDENTICAL to the registry's own TOOL_NAME_RE check, so a malformed
//   alias is always caught at validation, before ever reaching the
//   registry code path that would throw TOOL_ALIAS_INVALID), requires-
//   approval.ts (MAX_APPROVAL_LEVELS boundary at 10, non-integer levels,
//   and the exact minimum boundary at 1 — the `< 1` vs `<= 1` boundary
//   mutant only distinguishes at the value 1 itself), context-budget.ts
//   (a genuine llm_summarize success-path audit test, needed to prove
//   `llmProvider` is included — the two pre-existing llm_summarize tests
//   both only reached secrets-provider error paths). One new equivalence
//   class found here: context-budget.ts's audit meta spread condition
//   `v.mode === "llm_summarize" && v.llm` is unobservable in EITHER
//   direction (`&&`->`||`, or the first conjunct forced to `true`)
//   because `v.llm` is populated if-and-only-if `v.mode ===
//   "llm_summarize"` — validateContextBudgetInput's own return shape
//   guarantees the two conditions can never disagree on any reachable
//   input, confirmed via hand-mutation. 0 Stryker timeouts across all 3
//   verify rounds (no resource-contention contamination). Test file
//   authored directly (solo), while 5 sibling domain-9 files were being
//   closed concurrently via the parallel Workflow — see each file's own
//   entry above.
//
//   src/admin/audit/audit-export.ts (233 LOC — CSV/HTML compliance-
//   evidence serializers for the audit-log export route) 71 mutants, 94%
//   baseline (67/71, first-draft test since none existed) -> effectively
//   100% (70/71 + 1 accepted equivalent) in 1 verify round. New file
//   `audit-export-mutation.test.ts`. Pure-function module, no DB/Express
//   surface — direct import+call. 1 accepted equivalent: fmtDate's
//   trailing `$` regex anchor is redundant given the function's actual
//   ISO-8601 input shape (always exactly one dot-digits-Z substring, at
//   the end), hand-verified. Real gaps needed exact-adjacency assertions
//   (not just `.toContain()`) to distinguish whitespace-only
//   join-separator mutants from the real output. Closed via a
//   worktree-isolated parallel Workflow agent.
//   src/admin/audit/audit.ts (253 LOC — admin audit log: tamper-evident
//   hash-chain recording/verification, SIEM streaming, filtered/
//   paginated listing, action enumeration, bulk export) 116 mutants,
//   95.7% baseline (111/116 — the pre-existing audit-chain.test.ts's
//   tamper tests only ever corrupted `target` or deleted a row, so
//   verifyAuditChain's prev_hash linkage check was never isolated from
//   the content-hash recomputation check on the same line) -> **100%**
//   (116/116) in 1 verify round. New file `audit-mutation.test.ts`.
//   Closed by independently recomputing the expected sha256 digest via a
//   helper mirroring computeAuditHash's private formula, and by
//   tampering prev_hash ALONE (leaving hash/target untouched) plus a
//   manually-inserted NULL-prev_hash genesis row to isolate the linkage
//   check's own `?? ""` fallback. Zero equivalents or timeouts needed.
//   Closed via a worktree-isolated parallel Workflow agent.
//   src/admin/tool-composition/bundle-install-links.ts (289 LOC —
//   install-link token generation/redemption for MCP bundles: mints a
//   bundle-scoped MCP key + encrypted-at-rest raw secret + hashed opaque
//   token, resolves/revokes/lists them) 113 mutants, 92.0% baseline
//   (104/113, first-draft test since none existed) -> effectively 100%
//   (110/113 + 3 accepted equivalents) in 1 verify round. New file
//   `bundle-install-links-mutation.test.ts`. Real gaps: exact NOT_FOUND/
//   ALREADY_REVOKED error messages, a convergent-masking case on
//   `!rawToken` killed by planting a DB row whose token_hash deliberately
//   collides with `hashApiKey("")`, and a `log("warn", ...)` decrypt-
//   failure path killed via `spyOn(logger, "log")`. 3 accepted
//   equivalents, each hand-verified: `!Number.isInteger(id)` in
//   getInstallLinkRow (a throwaway bun:sqlite script confirmed a
//   non-integer REAL bound against an INTEGER PRIMARY KEY in a STRICT
//   table never matches a row, so the guard is redundant);
//   `rows.length === 0` in revokeAllInstallLinksForBundle (bypassing it
//   just runs a for-loop zero times over an empty array, a no-op
//   either way); and `if (!bundle) return null` in
//   resolveInstallLinkToken (proven unreachable via the same FK-cascade
//   argument already established for the sibling mcp_bundle_tools
//   table, re-verified against bundle_install_tokens's own ON DELETE
//   CASCADE FK from migration 46). Closed via a worktree-isolated
//   parallel Workflow agent.
//
//   src/admin/entities/schedules.ts (227 LOC — maintenance-schedule
//   cron matcher + CRUD + the once-a-minute leader-gated evaluator) 203
//   mutants, baseline unmeasured (its parallel-Workflow agent was
//   interrupted mid-verify, ~50% through, by the harness) -> effectively
//   100% (196/203 raw, 2 confirmed equivalent + 5 genuine infinite-loop
//   timeouts) after 3 solo verify rounds, rescued using the agent's own
//   salvaged (typecheck/test-clean) draft. New file
//   `schedules-mutation.test.ts`. Real gaps closed: a comma-list
//   combining one valid cron field-part with an inverted range (`5,10-5`)
//   — an ISOLATED inverted range alone can't distinguish the `lo > hi`
//   guard's forced-false direction, since the loop adds nothing either
//   way and the trailing `out.size > 0` fallback returns null via that
//   different path; `cronMatches` returning `false` (not throwing) for a
//   malformed expression; 3 createSchedule validation branches
//   (targetType/action enum, tool-type-without-toolName) whose existing
//   tests never registered the target client first, so an unrelated
//   LATER "client not found" guard was coincidentally also returning
//   INVALID_TARGET and masking whether the EARLIER checks did anything —
//   the schedules table's own `CHECK (target_type IN (...))`/
//   `CHECK (action IN (...))` constraints meant a truly-bypassed check
//   would surface as a thrown SQLite constraint violation, not a clean
//   INVALID_TARGET, once isolated; a client-type schedule that's ALSO
//   given a toolName must still persist `tool_name` as null (bun:sqlite
//   silently binds `undefined` the same as `null`, so a "toolName
//   omitted" test alone can't catch this — needs a real, non-null
//   toolName supplied alongside a "client" targetType); a malformed
//   tool-type row with a null tool_name (constructed via direct SQL,
//   createSchedule's own validation can never produce it) proving
//   applySchedule's `else if (s.toolName)` guard is genuinely
//   load-bearing via a `setToolEnabled` spy; and the exact stored
//   `last_run_minute` value (`getTime() / 60_000`, not `* 60_000`). 2
//   accepted equivalents (both on the SAME `out.size > 0` ternary,
//   hand-verified): every parseField code path that reaches this line
//   without an earlier `return null` is structurally guaranteed to have
//   added at least one element (the inner loop always runs once given
//   the already-checked `lo <= hi`/`step >= 1` invariants), so `out` can
//   never legitimately be empty there. 5 accepted GENUINE timeouts
//   (real infinite loops, not resource-contention noise — 0 unrelated
//   timeouts elsewhere across all 3 verify rounds): weakening the
//   `!Number.isInteger(step) || step < 1` guard (4 mutant variants) lets
//   a zero/negative step reach the range-fill loop, which then never
//   terminates; and reversing `v += step` to `v -= step` makes the same
//   loop decrease forever while `v <= hi` stays true. None of these 5 are
//   testable without constructing a real infinite loop, so — per this
//   program's established "genuine timeout = detected" convention — they
//   are accepted as-is, not chased.
//   src/admin/entities/approvals.ts (315 LOC — human-in-the-loop N-of-M
//   approval ticket lifecycle: requires-approval flags, ticket
//   create/decide/consume, operator webhook notifier) 157 mutants,
//   94.9% baseline (149/157 — the existing hand-written test left
//   getApprovalConfigForClient/notifyApproval/listApprovals()'s
//   no-filter form completely untested, and used loose
//   `toMatchObject({ok:false})` assertions that masked several
//   branch-specific mutants) -> effectively 100% (152/157 + 5 accepted
//   equivalents) in 1 verify round. New file `approvals-mutation.test.ts`.
//   5 accepted equivalents, all hand-verified: a `!== undefined`
//   short-circuit subsumed by the very next `Number.isInteger(undefined)
//   === false` clause, plus a 4-mutant cluster inside decideApproval's
//   `r.changes === 0` branch — a TOCTOU race-guard structurally
//   unreachable in this codebase's fully synchronous, single-connection
//   execution model (no test process can interleave a write between the
//   fresh read and the guarded UPDATE). Closed via a worktree-isolated
//   parallel Workflow agent.
//   src/admin/config/config-io.ts (302 LOC — exportConfig/importConfig,
//   the config-as-code serialization layer: bundles/alerts/
//   clients+tools/guardrails/consumers import-export with
//   best-effort skip-and-report + dry-run semantics) 179 mutants, 97.2%
//   baseline (174/179, first-draft test since none existed) -> **100%**
//   (179/179) in 1 verify round. New file `config-io-mutation.test.ts`.
//   Found (and pinned, not fixed — out of scope for a test-only pass) a
//   genuine production inconsistency: the bundle-tools "missing tools"
//   validation defensively does `(b.tools ?? []).filter(...)`, but the
//   apply step two lines later calls createBundle/updateBundle with the
//   RAW `b.tools`, so a hand-edited config with an omitted `tools` key
//   sails past validation and then throws deep in bundles.ts's
//   dedupeToolRefs — confirmed via hand-mutation that `.rejects.toThrow()`
//   on current behavior is precisely what distinguishes real from
//   mutated code here. Zero equivalents or timeouts needed. Closed via a
//   worktree-isolated parallel Workflow agent.
//   src/admin/tool-composition/bundles.ts (355 LOC — MCP bundle CRUD
//   entity/business logic: createBundle/updateBundle/listBundles/
//   getBundleDetail, tool-ref and composite-ref validation, hot-path
//   cache sync) 214 mutants, 61% baseline (130/214 — getBundleToolKeys/
//   getBundleComposites read the in-memory liveBundles cache while
//   getBundleDetail reads straight from SQL, and the existing
//   hand-written test mostly asserted via the cache getters, leaving
//   updateBundle's underlying SQL write path unguarded) -> effectively
//   100% (212/214 + 2 accepted equivalents) across 2 verify rounds. New
//   file `bundles-mutation.test.ts`. 2 accepted equivalents (both
//   hand-verified): the `updated_at` "bump only when neither description
//   nor enabled changed" compound guard's two sub-clauses are each
//   redundant, since the described/enabled branches already stamp
//   `updated_at` to the SAME `now` captured once per call — the "extra"
//   bump either clause would otherwise skip is an unobservable no-op
//   rewrite of the identical value. Closed via a worktree-isolated
//   parallel Workflow agent.
//   src/admin/tool-composition/composites.ts (505 LOC — composite/
//   macro-tool CRUD entity layer: step sequencing, $ref/${} arg
//   templating, per-step dispatch via proxyToolCall, live-cache sync;
//   the execution engine underneath the already-tested route/CRUD HTTP
//   layer) 425 mutants, 52.2% baseline (222/425 — the existing
//   hand-written composites.test.ts covered templating basics/CRUD
//   happy paths/runComposite threading but never asserted exact
//   error-message text, and left several convergent-clause triple-OR
//   type guards and extractText's multi-content-array branch
//   completely unexercised) -> effectively 100% (419/425 + 6 accepted
//   equivalents) across 3 verify rounds. New file
//   `composites-mutation.test.ts`, 86 tests. **DOMAIN 9's LAST FILE —
//   see the DOMAIN 9 COMPLETE marker below.** Notable techniques: a
//   spoofed-`.type`-on-a-function fixture to isolate the FIRST clause of
//   a `typeof x !== "object" || x === null || x.type !== "object"`
//   triple-OR (any primitive already independently satisfies the third
//   clause, masking the first — the same convergent-clause class this
//   program has hit repeatedly); an `Object.defineProperty`
//   non-enumerable-property fixture proving the `$ref`-shortcut check is
//   `Object.keys`-based, not dot-access-based; and directly mocking
//   `proxyToolCall` (same technique as routes-tools-mutation.test.ts) to
//   feed a heterogeneous multi-content array through extractText, since
//   no real REST/WS dispatch path ever synthesizes more than one
//   `{type:"text"}` content entry. 6 accepted equivalents, ALL
//   hand-verified: getByPath's `node === undefined` guard-half (bypassed,
//   it still lands on the same final `else return undefined` since
//   `typeof undefined !== "object"`); runComposite's dead `last`
//   initializer (always overwritten — the loop is guaranteed >=1
//   iteration and every iteration either returns early or reassigns
//   `last` before the loop ends); the JSON.parse catch body (assigning
//   `undefined` to an already-`undefined` `let json`); and refreshCache's
//   `!detail` branch (unreachable — always called immediately after its
//   own committed insert/update, serialized per-name by the same mutex).
//   Closed via a worktree-isolated parallel Workflow agent.
//
// **── DOMAIN 9 (src/admin, 33 files incl. types.ts skipped = 32 needing
// coverage) COMPLETE (2026-07-10) ──** Final roster, all effectively
// 100%: the 19-file src/admin/tool-policies/mutations/ batch (enabled,
// sensitive, guards, cache, coalesce, pagination, streaming, transform,
// mock, quarantine-policy, redact-paths, guardrails, overrides,
// graphql, requires-approval, context-budget, ws, monitor, index.ts),
// policies.ts, config-diff.ts, teams.ts, config-versions.ts,
// consumers.ts, audit-export.ts, audit.ts, bundle-install-links.ts,
// schedules.ts, approvals.ts, config-io.ts, bundles.ts, composites.ts
// (32 files; types.ts skipped, pure type declarations). 12 of the 13
// non-batch files (everything after the mutations/ batch) were closed
// via a SINGLE worktree-isolated parallel Workflow run (wf_58a63cec-c9b,
// batched 3/3/3/3/1 across 5 sequential batches on this 16-core/32-
// thread machine) — 11/12 completed cleanly end-to-end by their own
// agent, 1 (schedules.ts) needed solo rescue after being interrupted
// mid-verify. Domain 10 (misc: src/lib, src/cli, src/catalog,
// src/secrets, src/config*, ws-proxy.ts, server.ts, index.ts, ~32
// files) STARTED (2026-07-10), scaled immediately to a SECOND
// worktree-isolated parallel Workflow (run wf_ce4678ce-91a, 27 files
// batched 3-at-a-time across 9 sequential batches), same dual-track
// pattern as domain 9. 3 files deliberately EXCLUDED from the parallel
// run for solo/special handling: ws-proxy.ts (517 LOC, real WS server +
// DNS-pinning + bun:sqlite, coverage currently split across 3 existing
// test files), src/index.ts (217 LOC, real process entrypoint —
// getDb()/bootstrap/background-loops/app.listen all run at
// module-import time, no safe unit-import path), src/cli/index.ts (39
// LOC, same process-exit-on-import problem, argv-dispatch then
// `process.exit(await main())` at module top level). 2 files SKIPPED
// entirely (types/data-only, no runtime logic, same precedent as this
// program's other such skips): src/secrets/provider.ts (pure
// SecretsProvider interface) and src/catalog/builtin.ts (a static
// BuiltinCatalogEntry[] array, zero functions/branches). GOTCHA
// reconfirmed: src/catalog/index.ts's existing test lives at the ROOT
// src/__tests__/catalog.test.ts, NOT a mirrored src/catalog/__tests__/
// — same "test dir doesn't always mirror 1:1" class as domain 4's
// ip-validator.ts and domain 5's load-balancer.ts.
//   src/lib/crypto.ts (16 LOC — shared sha256Hex(input) helper, a thin
//   node:crypto createHash("sha256").update(input,"utf8").digest("hex")
//   wrapper used by 7+ call sites) 4 mutants (the smallest scope seen in
//   this whole program), 75% baseline (3/4, no prior test existed) ->
//   **75%** (3/4, 1 accepted equivalent) after 1 verify round, stable
//   across 2 independent Stryker runs (ruling out verify noise). New
//   dir + file src/lib/__tests__/crypto-mutation.test.ts. 1 accepted
//   equivalent, hand-verified across ASCII/emoji/Latin-1 inputs with a
//   "latin1" control: Node's Hash.update() normalizes an
//   unrecognized/empty encoding string to the same default as "utf8",
//   so no input can distinguish `"utf8"` from `""` at the JS-string
//   level. Closed via a worktree-isolated parallel Workflow agent.
//   src/cli/commands/login.ts (15 LOC — CLI `login` subcommand:
//   validates --url/--token flags, persists via saveCliCredentials)
//   20 mutants, 100% baseline (20/20, no prior test existed) -> **100%**
//   in 1 verify round (no fix cycle needed — a genuinely clean first
//   draft). New dir + file
//   src/cli/commands/__tests__/login-mutation.test.ts. Notable: since
//   parseFlags (src/cli/args.ts) can only ever produce a string or
//   boolean flag value (never e.g. a number), the "invalid-type-but-
//   truthy" typeof-guard case was exercised via a flag with no
//   following value on argv (parseFlags stores it as boolean `true`,
//   distinct from the flag being absent). Closed via a worktree-
//   isolated parallel Workflow agent.
//   src/config.ts (382 LOC — the env-driven runtime `config` singleton:
//   ~90 fields computed once at module load from process.env, plus the
//   parseTrustProxy/parseSecretsProvider/parseCorsOrigins helpers) 460
//   mutants, 21.3% baseline (98/460 — the existing config-parsers.test.ts
//   only reached the `config` object transitively through its 3 parser
//   helpers, leaving every other field untested) -> effectively 100%
//   (452/460 + 8 accepted equivalents) in 1 verify round. New file
//   src/__tests__/config-mutation.test.ts. Closed via a data-table-
//   driven fresh-module-reimport technique (the sibling file's
//   cache-busting query-string trick, generalized to ~90 fields grouped
//   into 6 categories, each verified against 3 scenarios via only 4
//   dynamic re-imports total). 8 accepted equivalents, ALL hand-verified
//   via direct WHATWG URL-parsing experiments: a successfully-parsed
//   http/https URL's `.protocol` is always exactly one trailing colon,
//   its `.hostname` can never be empty, and its `.pathname` can never be
//   the empty string — making 4 defensive normaliseOrigin guards
//   unreachable-true; a 5th/6th/7th cluster in parseCorsOrigins's own
//   whitespace-only-input early-return is convergent-masked by an
//   independent fallthrough filter reaching the same `[]` result either
//   way. Also incidentally found and closed 4 REAL gaps in that same
//   region despite it nominally being the sibling file's territory: a
//   whitespace-padded `" * "` wildcard entry only round-trips correctly
//   because parseCorsOrigins's OWN pre-trim runs before
//   normaliseOrigin's (too-late) internal trim, and 3 two-part
//   concatenated error-message StringLiterals where the sibling test's
//   single `.toThrow(/regex/)` was satisfied by either half alone.
//   Operational note: this domain's usual `STRYKER_TEST_SCOPE="src/
//   __tests__"` convention fails Stryker's dry run outright for this
//   file specifically, because that directory also contains
//   config-schema.test.ts's 5 pre-existing/unrelated failures — scoped
//   down to just the two relevant test files instead. Closed via a
//   worktree-isolated parallel Workflow agent.
//   src/lib/mcp-result.ts (29 LOC — single toolResult() builder for the
//   shared MCP CallTool result envelope) 10 mutants, 100% baseline
//   (10/10, first-draft test since none existed) -> **100%** in 1
//   verify round. New file src/lib/__tests__/mcp-result-mutation.test.ts.
//   Zero equivalents or timeouts needed. Closed via a worktree-isolated
//   parallel Workflow agent.
//   src/cli/commands/pull.ts (24 LOC — CLI command that GETs the live
//   config export and writes it into gateway.yaml's config: section,
//   preserving any existing hand-authored servers: list) 12 mutants,
//   92% baseline (11/12, no existing test previously covered
//   pullCommand) -> effectively 100% (11/12 + 1 accepted equivalent) in
//   1 verify round. New file
//   src/cli/commands/__tests__/pull-mutation.test.ts. 1 accepted
//   equivalent: the catch block's only statement assigns `undefined` to
//   a `let servers` already implicitly undefined (no initializer), a
//   no-op either way. Closed via a worktree-isolated parallel Workflow
//   agent.
//   src/config-schema.ts (388 LOC — typed zod validation of process.env;
//   flags unknown/malformed env vars at boot without altering config.ts's
//   own parsed shape) 218 mutants, 56.9% baseline (124/218 own-file
//   score — the existing config-schema.test.ts, untouched, covers basic
//   PORT/AUTH_DISABLED/LOG_FORMAT/SECRETS_PROVIDER cases but misses
//   envUrl/envCsv/envOptString entirely, exact min/max boundaries, and
//   validateEnvOrWarn/validateEnvStrict's exact message formats) ->
//   81.7% own-file score (178/218 + 40 confirmed equivalents) across 2
//   STABLE verify rounds (identical 40-survivor set both times, ruling
//   out verify noise). New file
//   src/__tests__/config-schema-mutation.test.ts. OPERATIONAL GOTCHA:
//   the zod version resolved in this repo (4.4.3) requires every
//   z.object key to be textually PRESENT in the input (a key merely
//   absent, vs present-with-undefined, fails validation even for an
//   optional-typed field) — this is the confirmed root cause of
//   config-schema.test.ts's 5 pre-existing failures, and it ALSO means
//   Stryker's dry run cannot use the shared `STRYKER_TEST_SCOPE="src/
//   __tests__"` for this file (the dry run requires the WHOLE scope to
//   pass first) — verification was scoped to just this new file's own
//   path instead, so the reported score is this file's OWN standalone
//   kill rate, not a combined score with the untouched sibling (the
//   combined score in a fixed-zod environment would only be >= this,
//   per the agent's own reasoning, never lower). All 40 accepted
//   equivalents trace to ONE structural root cause, hand-verified for 6
//   representative mutants plus a full code-trace of validateEnv:
//   `EnvReport` never returns `result.data`, so every `.transform()`
//   callback's OUTPUT VALUE (envBool's boolean, envCsv's array,
//   envOptString's trimmed string, several `v ?? default` string
//   constants, and envInt/envEnum's `def` argument in the early-return
//   branch that bypasses min/max/enum checking) is fundamentally
//   unobservable through the public contract — only
//   result.success/result.error.issues are ever read. 5 genuinely
//   observable arithmetic-bound mutants (computed MAX arguments) plus
//   the entire 45-literal unknown-env-prefix array and its guard were
//   real gaps, closed with boundary-value tests. Closed via a
//   worktree-isolated parallel Workflow agent.
//   src/lib/identifier.ts (66 LOC — shared identifier-shape regex
//   validators isValidToolName/isValidAdminEntityName plus the
//   client__tool composite-key encode/decode pair toolKey/splitToolKey)
//   25 mutants, 100% baseline (25/25, first-draft test since none
//   existed) -> **100%** on the FIRST run, no verify rounds needed. New
//   file src/lib/__tests__/identifier-mutation.test.ts, 37 tests.
//   Deliberately covered both regexes' min/max-length boundaries, an
//   explicit cross-check that the two regexes reject each other's
//   permissive cases (the source's own doc comments call out that
//   conflating them would be a regression), and a splitToolKey input
//   containing its own separator to pin indexOf-vs-lastIndexOf
//   semantics. Closed via a worktree-isolated parallel Workflow agent.
//   src/cli/connect-templates.ts (279 LOC — per-MCP-client config-
//   snippet generator: Claude Desktop/Cursor/Windsurf/Continue/generic-
//   JSON templates plus generateConnectSnippet/resolveGatewayEndpoint/
//   isConnectClientId) 112 mutants, 78.6% baseline (88/112 — the
//   existing 199-LOC test exercised generate() output but never read
//   template objects' own id/label fields, never inspected untouched
//   `instructions` array lines, and used bare `.toThrow()` without
//   checking exact thrown messages) -> **100%** (112/112) in 1 verify
//   round. New file connect-templates-mutation.test.ts. Zero
//   equivalents or timeouts needed — notably, apiKeyHint's own
//   template-literal body was NOT a gap despite looking like one:
//   Stryker's StringLiteral mutator collapses the WHOLE template literal
//   (including its interpolated placeholder expression) at once, which
//   the sibling test's existing `.some(i => i.includes(PLACEHOLDER))`
//   check already catches since the placeholder vanishes too. Closed
//   via a worktree-isolated parallel Workflow agent.
//   src/cli/args.ts (32 LOC — hand-rolled parseFlags() argv parser)
//   39 mutants, 92% baseline (36/39 — the existing cli.test.ts, which
//   also covers config-file.ts, never exercised a flag as the literal
//   LAST argv element) -> effectively 100% (37/39 + 2 accepted genuine
//   timeouts) in 1 verify round. New file args-mutation.test.ts. The 2
//   accepted timeouts are both loop-counter UpdateOperator flips
//   (`i++`->`i--`, `++i`->`--i`) causing genuine infinite loops, not
//   fixable via assertions — same "inherent hang, not a coverage gap"
//   class as this program's other loop-counter timeout findings.
//   OPERATIONAL NOTE — a NEW confirmed instance of this program's
//   documented verify-noise gotcha: the first 2 Stryker runs against
//   this file's already-authored, provably-correct test both reported 2
//   false survivors (the exact 2 real gaps this file needed) despite a
//   direct `bun test` confirming the test file genuinely killed both
//   mutations when hand-applied — only a 3rd, fresh run reported the
//   correct 0-survivor result. Treat any single Stryker run against a
//   freshly-authored file with mild suspicion; re-run once before
//   trusting a survivor list, per [[px2_proxy_verification_noise]].
//   Closed via a worktree-isolated parallel Workflow agent.
//   src/secrets/local-provider.ts (25 LOC — zero-config SecretsProvider
//   wrapping security/secret-box.ts's sync encrypt/decrypt/isConfigured
//   in async shims) 5 mutants, 100% baseline (5/5, first-draft test
//   since none existed) -> **100%** in 1 verify round (stable across a
//   2nd stability-check run, 0 survivors both times). New file
//   local-provider-mutation.test.ts. Test design specifically
//   cross-checked every call against secret-box.ts's real functions
//   imported independently under a different name, so a mutant breaking
//   the DELEGATION itself (dropped argument, swapped underlying
//   function, wrong return) would be caught, not just a body-emptied
//   mutant that already looks broken via a thrown/undefined check.
//   Closed via a worktree-isolated parallel Workflow agent.
//
// P2-1/P2-2 used a single file (compare.ts) to validate the pipeline
// end-to-end. P2-3 keeps that incremental pattern rather than mutating
// all of `src/security/*.ts` at once (12 files / 946 mutants / ~8h /
// ~284 survivors — too coarse for a single commit): we scope to the 4
// smallest security-critical files and drive each to 100%. Stryker's
// default `mutate` excludes `__tests__/`, `__snapshots__/`, and
// `*.test.*` from the mutant set, so test files are never mutated
// regardless of what we list here.
//
// Remaining src/security/ files → dedicated follow-up tickets, largest
// last: oidc.ts (429 LOC), mcp-key-store.ts (242), jwt.ts (229),
// session-store.ts (140), user-store.ts (124), startup-guards.ts (79),
// bootstrap-admin.ts (53). Then src/proxy (pipeline), src/mcp/registry.
//
// (Note: glob patterns intentionally NOT shown inline — a `**` followed by
// `/` inside a `/* */` block comment would close the comment early, which
// is why we use `src/security/*.ts` and refer to `src/proxy/...` as plain
// paths in the comments above.)
//
// CONCURRENCY (2026-07-06): MUST be 1. Reproduced failure: with
// `concurrency: 8`, Stryker's command-test-runner spawns 8 parallel
// `bun run test` processes from the SAME sandbox CWD. Confirmed locally:
// 8 parallel bun:test runs from the sandbox produced 1223 pass / 4 fail
// (vs the serial baseline 1227/0). The 4 failures are resource
// contention — SQLite lock + Express port-bind + bun:test snapshot file
// collisions between workers. Stryker's command-test-runner maps
// `exitCode !== 0` to a single "All tests" Failed result, which the
// dry-run executor then turns into `ConfigError: There were failed
// tests in the initial test run`. To use concurrency>1 here we'd need
// perTest coverage analysis + sandbox isolation per worker — out of
// scope for P2-3.
//
// To run:                 bun run test:mutate
// To run a single file:   bunx stryker run --mutate src/security/compare.ts
//
export default {
  commandRunner: {
    // Use the wrapper at `scripts/stryker-test-runner.ts` instead of
    // `bun run test` directly. The wrapper exists for one reason:
    // Stryker's `command` test runner uses Node's `child_process.exec`,
    // which buffers child stdout/stderr up to `maxBuffer` (1 MB default).
    // Our `bun run test` produces ~7 MB of output per run, so the buffer
    // overflows, Node kills the child with SIGTERM, and Stryker sees a
    // non-zero exit → `All tests` Failed → the dry run rejects the run
    // even though the suite is 1227 pass / 0 fail. The wrapper spawns the
    // test command via `Bun.spawn` (no buffer cap, output streams to a
    // file) and propagates the exit code. It also pins
    // `NODE_ENV=test` + `SESSION_COOKIE_SECURE=true` so `.env.test`'s
    // hermetic overrides win over the sandbox's `.env`. See
    // `scripts/stryker-test-runner.ts` for the full rationale.
    //
    // Note on the `--path-ignore-patterns={admin-ui,e2e}/**` filter: it
    // is required because bare `bun test` (no args) sweeps up
    // `admin-ui/src/**/__tests__/*.test.ts` (Vitest specs needing jsdom
    // — fail with "document is not defined") and `e2e/*.spec.ts`
    // (Playwright specs — fail with "Playwright Test did not expect
    // test() to be called here"). The wrapper invokes `bun test` with
    // that filter applied directly. See CLAUDE.md §Commands.
    command: "bun scripts/stryker-test-runner.ts",
  },
  mutate: [
    // Domain 6 (src/discovery) is COMPLETE. Domain 7 (src/observability,
    // 10 files) is COMPLETE. Domain 8 = src/routes + src/routes/admin
    // is IN PROGRESS: docs.ts, validation.ts, http-errors.ts, traces.ts,
    // admin/connect.ts, admin/monitors.ts, admin/overview.ts,
    // introspection.ts, usage.ts, tags.ts, admin/index.ts,
    // admin/canary.ts, admin/traffic.ts, register.ts, admin/oauth.ts,
    // install-links.ts, admin/audit-log.ts, admin/approvals.ts,
    // schedules.ts, metrics.ts, health.ts, teams.ts, backup.ts,
    // admin/users.ts, upstream-auth.ts, admin/clients.ts,
    // consumers.ts, admin/lb.ts, config-io.ts, policies.ts, auth.ts,
    // alerts.ts, ws-proxy-admin.ts, discovery.ts, catalog.ts,
    // auth-oidc.ts, composites.ts, mcp-keys.ts, bundles.ts,
    // admin-validators.ts, admin/tools.ts — **DOMAIN 8 COMPLETE**
    // (see SCOPE HISTORY for the full retrospective). **DOMAIN 9
    // (src/admin, 32 files needing coverage) COMPLETE** — see the
    // DOMAIN 9 COMPLETE marker in SCOPE HISTORY for the full roster and
    // retrospective. Domain 10 = misc (~32 files) IN PROGRESS: crypto.ts,
    // src/cli/commands/login.ts, and src/config.ts are done (see SCOPE
    // HISTORY). The remaining ~24 routine files (11 src/lib/*.ts, 3 more
    // src/cli/*.ts, 4 src/cli/commands/*.ts, src/catalog/index.ts, 3
    // src/secrets/*.ts, src/config-schema.ts, src/server.ts) are being
    // worked concurrently by a worktree-isolated parallel Workflow (run
    // wf_ce4678ce-91a). ws-proxy.ts/src/index.ts/src/cli/index.ts are
    // held back for solo/special handling once the parallel run finishes
    // (see SCOPE HISTORY for why). `mutate` below is scoped to
    // src/lib/identifier.ts purely as a placeholder pointer — do NOT
    // launch a solo run against it (or any file the parallel Workflow's
    // FILES list already covers) while that worktree is still active.
    "src/lib/identifier.ts",
  ],
  plugins: ["@stryker-mutator/typescript-checker"],
  tsconfigFile: "tsconfig.json",
  // Some mutants produce infinite loops in pathological cases (e.g.
  // replacing `while (cond)` with `while (true)`). Allow each test run
  // up to 60s before timing out.
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  // No coverage analysis — see top-of-file comment.
  coverageAnalysis: "off",
  // Console + JSON + HTML.
  reporters: ["progress-append-only", "json", "html"],
  // MUST be 1 with the FULL suite (fixed-port / DB-file tests collide between
  // workers). Safe at >1 when scoped to src/security/__tests__ — none of those
  // tests bind a fixed port (the one server test uses listen(0)) or a shared
  // DB file (all :memory:), and none use snapshots. See CONCURRENCY note above.
  // Validated empirically: user-store scores identically at 1 and 8.
  concurrency: 8,
  jsonReporter: { fileName: "reports/mutation/result.json" },
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // Don't run snapshot files (Stryker's default `mutate` already excludes
  // `**/__tests__/**` and `**/__snapshots__/**` from the set of files to
  // mutate).
  //
  // Note: do NOT put `**/__tests__/**` here as a "defensive" ignore. With
  // `coverageAnalysis: "off"` Stryker copies only the files it knows about
  // into the sandbox; an `ignorePatterns` entry here would prevent test
  // files from being copied, and `bun test` from the sandbox CWD would
  // then find 0 test files and fail the initial dry run. We only ignore
  // snapshot files, which are written to disk by bun:test and are not
  // loadable as test files on their own.
  ignorePatterns: ["**/__snapshots__/**"],
};
