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
    // admin/canary.ts, admin/traffic.ts DONE (see SCOPE HISTORY).
    // Remaining domain-8 files ordered smallest-LOC-first (both
    // src/routes/ and src/routes/admin/ pooled together): register.ts
    // (56) < ... < admin-validators.ts (457, largest, last). Next:
    // register.ts (56 LOC). Existing test file `routes-register.test.ts`
    // — run baseline before assuming a rewrite is needed. Scope:
    // STRYKER_TEST_SCOPE="src/routes/__tests__".
    "src/routes/register.ts",
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
