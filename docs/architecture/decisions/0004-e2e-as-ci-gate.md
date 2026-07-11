# E2E tests as a CI gate

- Status: accepted
- Date: 2026-07-06
- Deciders: CarlxsMG (QA + DX), Claude Sonnet 5 (review)

## Context and Problem Statement

The repo had one happy-path e2e (`e2e/smoke.spec.ts`) since the first
tagged release. It exercised login → register a backend → call the
discovered tool, which is good as a smoke check but **does not exercise
the failure modes** the bridge exists to govern:

- Does the data plane lock down the moment a managed MCP key is minted?
- Does the protocol layer (`initialize`, `tools/list`, `tools/call`)
  return a real `serverInfo`, real tool schemas, and surface upstream
  errors as `isError: true` instead of dropping the session?
- Does an unknown tool invocation fail with `isError: true` (recoverable)
  rather than a transport error (session-killing)?

Without these flows under test, regressions in the auth model (the
single highest-risk code path) and in the protocol envelope (the
single highest-visibility contract) would only be caught in production.
Unit tests cover the components in isolation; what was missing was
end-to-end confidence that the components **wire together correctly**
under real HTTP and real Playwright browser semantics.

The question: how many of the REVIEW §2.4 e2e flows do we add, and how
do we wire them so they actually gate merges instead of being a
"best-effort" check that someone disables when it's flaky?

## Decision Drivers

- **CI-gated, not advisory.** A flaky e2e suite that's allowed to be
  ignored teaches the team to ignore it. The bar is "must pass on every
  PR" — not "runs nightly and tells us about trends."
- **Order-independent.** bun:test runs files in parallel; e2e specs in
  series. The suite must not assume any prior spec ran. Each spec mints
  its own managed MCP key with a unique label and tears down its
  fixtures in `beforeAll` / `afterAll`.
- **Real browser, real backend.** Mocks of `fetch` and `WebSocket` test
  the wiring inside the test, not the wiring under load. Playwright
  gives us a real Chromium talking to a real `bun run src/index.ts`
  on a real port — the closest we can get to production in CI.
- **Cache the browser.** Re-downloading Chromium on every CI run is
  ~30 s of pure waste. `actions/cache` keyed on the Playwright version
  drops install time to near-zero on cache hit.

## Considered Options

- **A. Keep one smoke spec; add e2e tests as opt-in (`bun run test:e2e`,
  not in CI).** Status quo before this decision. Rejected: opt-in
  e2e that isn't a gate is documentation, not a test.
- **B. Add many e2e flows, run them all on every PR.** Tempting but
  rejected for this iteration: REVIEW §2.4 lists four flows
  (fail-closed, protocol, admin lifecycle, canary). Adding all four at
  once would have produced a single massive commit; splitting the
  rollout keeps each commit bisectable.
- **C. Land two flows now (auth-fail-closed, protocol) with a CI job
  that runs both, leaving the canary and bundle-install flows for
  follow-up.** Chosen.

## Decision Outcome

Chosen option: **C — two new specs, wired to a new CI job, with
the remaining two flows tracked as backlog**.

Specs landed:

- `e2e/auth-fail-closed.spec.ts` (5 tests). The data plane starts in
  open mode (no auth material configured), then locks down the moment
  a managed MCP key is minted via the admin API: no Authorization → 401,
  bogus Bearer → 403, the right key → 200, revoked key → 403. Covers
  the lock-down transition the prior smoke test could not catch.
- `e2e/mcp-protocol.spec.ts` (6 tests). Protocol contract for
  `/mcp/:clientName`: `initialize` returns a real `serverInfo`,
  `tools/list` advertises the discovered `client__tool` with the
  OpenAPI-derived name and `inputSchema`, `tools/call` for a known
  tool returns the upstream payload, and three error paths (unknown
  tool, invalid args, upstream 404) all surface as `isError: true`
  rather than dropping the session. The unknown-tool case in
  particular was a known MCP gotcha — a transport error here kills
  the session, an `isError` keeps it alive for the next call.

The smoke spec was updated for the `/mcp` split (ADR-0001) — it now
hits `/mcp/:clientName` (the data plane shard) instead of the
post-split `/mcp` (the control plane gate).

CI wiring:

- New `e2e` job in `.github/workflows/ci.yml`. Depends on the `test`
  job so a lint or typecheck break fails the PR before the slower
  browser step runs.
- Caches Playwright browsers across runs via `actions/cache` keyed on
  the Playwright version.
- Installs Chromium with `--with-deps` on cache miss (the `--with-deps`
  part matters on Linux runners — without it, missing system libraries
  cause silent browser launch failures).
- Uploads the `test-results/` and `playwright-report/` artifacts on
  failure, with a 7-day retention, so a failed CI run can be debugged
  from the PR page without re-running.

### Consequences

- Good, because every PR now exercises the two highest-risk code
  paths (the auth model and the protocol envelope) under real HTTP
  and a real browser before merge.
- Good, because the suite is order-independent — each spec mints its
  own key, so a developer running one spec in isolation gets the same
  result as running the full suite.
- Good, because the cache + dependency chain keeps the e2e job to
  ~25 s on cache hit, fast enough that CI feedback stays useful.
- Good, because the smoke spec's update catches the ADR-0001 contract
  in CI: any future regression that re-flattens `/mcp` (e.g. someone
  reintroducing the aggregate) breaks the smoke test.
- Bad, because the e2e suite now requires Chromium on every CI runner
  (~150 MB install on first run, even with cache). For a self-hosted
  GitHub runner this is fine; for a constrained CI it may need a
  matrix split later.
- Bad, because Playwright's `test-results/` and `playwright-report/`
  can leak backend URLs and test data in their HTML output. The CI
  job uploads these only on failure, which limits the exposure, but
  a paranoid deployment would want to scrub them before publishing.

### Confirmation

- `.github/workflows/ci.yml` `e2e` job: must pass on every PR.
- Each spec mints its own MCP key in `beforeAll` with a label unique
  to the spec (e.g. `auth-fail-closed.spec.ts: keyLabel =
"e2e-auth-fail-closed"`) so the suite is order-independent.
- The CI failure mode is visible: the job uploads the Playwright
  report as a PR artifact, and the failing line is captured in the
  job log with a stack trace.

## More Information

- Commits:
  - `d58fd30` — `test(e2e): add auth-fail-closed + mcp-protocol specs,
fix smoke for new /mcp split (P1-3)`
  - `d5ed472` — `ci: add e2e job running the Playwright suite (12 specs)
on every PR`
- Follow-up (still open): canary fail-over spec, bundle-install spec —
  both await a future session; they need real canary / bundle-install
  fixtures, which is more than a 1-hour drop-in.
- Related code: `e2e/*.spec.ts`, `.github/workflows/ci.yml`.
