#!/usr/bin/env bun
/**
 * Wrapper that runs the project's test suite from inside a Stryker sandbox
 * and returns its exit code, while redirecting stdout/stderr to a log file.
 *
 * WHY THIS EXISTS (2026-07-06, P2-1):
 *
 * Stryker's built-in `command` test runner uses Node's `child_process.exec`,
 * which buffers stdout/stderr up to a hard-coded `maxBuffer` (1 MB by default
 * in Node). For our `bun run test` command that's not enough — the full test
 * run produces ~7 MB of output (50 snapshots, 4902 expect() calls, plus the
 * application's own JSON log stream). When the buffer overflows, Node kills
 * the child with SIGTERM and exits with a non-zero code. Stryker then sees
 * `All tests` failed and throws
 *   `ConfigError: There were failed tests in the initial test run.`
 * …even though the test suite itself was 1227 pass / 0 fail.
 *
 * Bypassing `exec`'s buffer: we spawn the test command via `Bun.spawn` (no
 * maxBuffer at all — output streams directly to a file). Then we exit with
 * the same code. Stryker's exec() now only captures this wrapper's tiny
 * stdout (nothing), so the buffer issue goes away.
 *
 * USAGE FROM STRYKER:
 *   commandRunner: { command: "bun scripts/stryker-test-runner.ts" }
 *
 * The CWD Stryker uses is the per-mutation sandbox (e.g. `.stryker-tmp/
 * sandbox-XXXX/`), so this script inherits it and runs `bun run test` from
 * there. The script deliberately uses `process.execPath` to invoke bun
 * itself rather than going through PATH lookup — see scripts/check-all.ts
 * for why (the bare `bun` resolution in CWD picks up a 0-byte placeholder
 * file before reaching the real `bun.cmd`).
 *
 * LOG FILE:
 *   The full test output goes to `.stryker-test-output.log` in the sandbox
 *   CWD. One file per invocation, so each mutant run has its own log to
 *   grep on failure — no cross-mutation log collisions.
 */

// Invoke `bun test` directly (NOT `bun run test`) because `bun test` forces
// NODE_ENV=test and applies .env.test overrides — which `bun run test` does
// not. Skipping `run` keeps the hermetic env guarantees that the project's
// package.json `test` script relies on. See .env.test's comment for the full
// rationale (it pins SESSION_COOKIE_SECURE=true so contributor .env's
// SESSION_COOKIE_SECURE=false escape hatch doesn't leak into the test env).
const TEST_ARGS = ["test", "--path-ignore-patterns={admin-ui,e2e}/**"];
const LOG_FILE = ".stryker-test-output.log";

// Build the child env. The wrapper bun process loaded .env into its own
// process.env before this script ran, so any value .env sets is already
// baked into the inherited child env. Bun's dotenv loader only fills
// *unset* variables, so .env.test can't override those later. The repo's
// .env.test sets SESSION_COOKIE_SECURE=true to keep cookie-naming tests
// hermetic against the developer's local .env which uses
// SESSION_COOKIE_SECURE=false for plain-http dev. We pin the same value
// here so the child bun sees the secure-by-default state regardless of
// what the parent sandbox .env says.
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  SESSION_COOKIE_SECURE: "true",
};

const child = Bun.spawn({
  cmd: [process.execPath, ...TEST_ARGS],
  cwd: process.cwd(),
  env: childEnv,
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
});

// Concatenate the test process's stdout+stderr into a single log file.
// We can't use a FileSink with stdout/stderr in Bun.spawn directly (Bun
// restricts stdio entries to 'inherit' | 'ignore' | null), so we read the
// piped streams and write them out ourselves, fanning the writes through
// a single file writer.
const out = Bun.file(LOG_FILE);
const writer = out.writer();
writer.start(); // truncate any previous run

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        writer.write(decoder.decode(value, { stream: true }));
      }
    }
    // Flush any trailing partial decode at EOF.
    writer.write(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

await Promise.all([drain(child.stdout), drain(child.stderr)]);
const exitCode = await child.exited;
await writer.flush();
await writer.end();

// Propagate the test command's exit code so Stryker's command-test-runner
// maps a green run to `All tests | Success` and a red run to `All tests |
// Failed`. With `coverageAnalysis: "off"` Stryker treats the whole run as
// one synthetic "All tests" case — intentional, matches what the original
// `bun run test` invocation already did.
process.exit(exitCode ?? 1);