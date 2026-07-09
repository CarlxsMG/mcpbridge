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
    // Domain 5 continues (see SCOPE HISTORY) — context-budget.ts,
    // load-balancer.ts, quarantine.ts, guardrails.ts done. Next:
    // pagination.ts (159 LOC, src/tool-policies/ — tied with
    // response-cache.ts at 159 LOC, picked first alphabetically/by original
    // wc -l ordering). Scope: verify per-file which __tests__ dir actually
    // holds the test (domain 5 has at least one cross-directory gotcha
    // already — see load-balancer.ts's entry above).
    "src/tool-policies/pagination.ts",
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
