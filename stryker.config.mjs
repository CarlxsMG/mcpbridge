//
// Stryker mutation-testing config.
//
// Coverage analysis is OFF (`coverageAnalysis: "off"`): the Bun test runner
// doesn't emit a coverage report Stryker can parse natively, so every mutant
// triggers a full `bun run test` run and the per-suite runtime dominates. The
// test command is wrapped (see `scripts/stryker-test-runner.ts`) to stream
// output past Node's exec `maxBuffer` cap and to pin the hermetic test env
// (`NODE_ENV=test`, `SESSION_COOKIE_SECURE=true`).
//
// The multi-session mutation-testing hardening program (P2 + domains 2-10) is
// complete: every file with meaningful runtime logic has a dedicated backstop.
// The blow-by-blow scope history that used to live in this file has been
// retired to keep the config readable — see the `test(mut): ...` commits in git
// history (and the project MEMORY notes) for the full retrospective.
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
    // even though the suite passes. The wrapper spawns the test command
    // via `Bun.spawn` (no buffer cap, output streams to a file) and
    // propagates the exit code. It also pins `NODE_ENV=test` +
    // `SESSION_COOKIE_SECURE=true` so `.env.test`'s hermetic overrides win
    // over the sandbox's `.env`. See `scripts/stryker-test-runner.ts`.
    //
    // Note on the `--path-ignore-patterns={admin-ui,e2e}/**` filter (applied
    // inside the wrapper): bare `bun test` sweeps up admin-ui Vitest specs
    // (jsdom — "document is not defined") and e2e Playwright specs. See
    // CLAUDE.md §Commands.
    command: "bun scripts/stryker-test-runner.ts",
  },
  mutate: [
    // The mutation-testing program is complete (see the header). This points
    // at the last file closed purely as a stable placeholder for ad-hoc
    // re-verification; there is no active target — scope a specific file here
    // when re-running against a change.
    "src/ws-proxy.ts",
  ],
  plugins: ["@stryker-mutator/typescript-checker"],
  tsconfigFile: "tsconfig.json",
  // Some mutants produce infinite loops in pathological cases (e.g.
  // replacing `while (cond)` with `while (true)`). Allow each test run
  // up to 60s before timing out.
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  // No coverage analysis — see the header comment.
  coverageAnalysis: "off",
  // Console + JSON + HTML.
  reporters: ["progress-append-only", "json", "html"],
  // MUST be 1 with the FULL suite (fixed-port / DB-file tests collide between
  // workers). Safe at >1 when scoped to src/security/__tests__ — none of those
  // tests bind a fixed port (the one server test uses listen(0)) or a shared
  // DB file (all :memory:), and none use snapshots.
  // Validated empirically: user-store scores identically at 1 and 8.
  concurrency: 8,
  jsonReporter: { fileName: "reports/mutation/result.json" },
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // Don't run snapshot files. Do NOT add `**/__tests__/**` here as a
  // "defensive" ignore: with `coverageAnalysis: "off"` Stryker copies only the
  // files it knows about into the sandbox, so ignoring test files would leave
  // `bun test` with 0 test files and fail the initial dry run. We only ignore
  // snapshot files, which bun:test writes to disk and aren't loadable on their own.
  ignorePatterns: ["**/__snapshots__/**"],
};
