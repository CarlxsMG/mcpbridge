#!/usr/bin/env bun
/**
 * Aggregate "is this repo healthy" check: root typecheck + tests, then
 * admin-ui typecheck + build. Runs each step sequentially via Bun.spawn and
 * stops at the first failure — mirroring dev-all.ts's approach of spawning
 * by the resolved bun executable path rather than raw shell `&&` chains, so
 * this works the same on Windows as it does on macOS/Linux.
 */
const root = `${import.meta.dir}/..`;

// See dev-all.ts for why we spawn by resolved path instead of bare "bun".
const bunExe = process.execPath;

// This script (bun scripts/check-all.ts) is itself a bun invocation, so Bun
// has already auto-loaded the repo's real (gitignored) .env into ITS
// process.env — e.g. the documented SESSION_COOKIE_SECURE=false local-dev
// escape hatch (.env.example). Bun.spawn inherits process.env by default, so
// without stripping it here, the "root tests" child below would start with
// SESSION_COOKIE_SECURE already *set*, which defeats .env.test's override:
// dotenv-style loading only fills in unset vars, it never clobbers ones a
// process already has (see .env.test's own comment + commit e56ae96, the fix
// that made a plain `bun test` hermetic against this exact var — that fix
// only guards a fresh shell invocation, not a bun test nested under another
// bun process like this one). Deleting it here lets the child re-derive it
// from .env → .env.test exactly as a fresh-shell `bun test` would.
const testEnv = { ...process.env };
delete testEnv.SESSION_COOKIE_SECURE;

interface Step {
  label: string;
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

const steps: Step[] = [
  // Format/lint run first and cheap-first: a formatting or lint error is
  // usually faster to spot and fix than waiting on typecheck/tests/build.
  { label: "format check", cmd: [bunExe, "run", "format:check"], cwd: root },
  { label: "lint (root)", cmd: [bunExe, "run", "lint"], cwd: root },
  { label: "lint (admin-ui)", cmd: [bunExe, "run", "lint"], cwd: `${root}/admin-ui` },
  { label: "root typecheck", cmd: [bunExe, "run", "typecheck"], cwd: root },
  // --path-ignore-patterns excludes admin-ui and e2e on purpose: a bare
  // `bun test` from the repo root also recurses into admin-ui/src/**/*.test.ts
  // (Vitest-only specs — jsdom environment + setupFiles wired in
  // admin-ui/vite.config.ts, run via the `vitest` binary; bun's own test
  // runner has no DOM, so those fail there with unrelated
  // "document/window is not defined" errors) and into e2e/*.spec.ts
  // (Playwright specs — bun also treats *.spec.ts as a test file by default,
  // and Playwright's own `test()` refuses to run outside the `playwright test`
  // runner, so bun sweeping them up fails with "Playwright Test did not
  // expect test() to be called here"). (A positional filter like `bun test
  // src` does NOT work as a directory scope — bun matches it as a substring
  // against the full file path, and "src" also matches "admin-ui/src/...".)
  // The admin-ui steps below cover that package; `bun run test:e2e` covers
  // the Playwright suite separately.
  {
    label: "root tests",
    cmd: [bunExe, "test", "--path-ignore-patterns={admin-ui,e2e}/**"],
    cwd: root,
    env: testEnv,
  },
  { label: "admin-ui typecheck", cmd: [bunExe, "run", "typecheck"], cwd: `${root}/admin-ui` },
  { label: "admin-ui tests", cmd: [bunExe, "run", "test"], cwd: `${root}/admin-ui` },
  { label: "admin-ui build", cmd: [bunExe, "run", "build"], cwd: `${root}/admin-ui` },
];

for (const step of steps) {
  console.log(`\n[check] ▶ ${step.label}`);
  const proc = Bun.spawn(step.cmd, {
    cwd: step.cwd,
    env: step.env ?? process.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n[check] ✗ ${step.label} failed (exit ${code})`);
    process.exit(code);
  }
  console.log(`[check] ✓ ${step.label}`);
}

console.log("\n[check] all checks passed");
