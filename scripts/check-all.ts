#!/usr/bin/env bun
/**
 * Aggregate "is this repo healthy" check: root typecheck + tests, then
 * admin-ui typecheck + build. Runs each step sequentially via Bun.spawn and
 * stops at the first failure — mirroring dev-all.ts's approach of spawning
 * by the resolved bun executable path rather than raw shell `&&` chains, so
 * this works the same on Windows as it does on macOS/Linux.
 */
const root = `${import.meta.dir}/..`;

/** `root` with separators normalised and `..` resolved — for Docker volume mounts. */
const dockerRoot = root.replace(/\\/g, "/").replace(/\/scripts\/\.\.$/, "");

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
//
// SECRET_ENCRYPTION_KEY gets the same treatment for the same reason: several
// tests assert the "secret box unconfigured" error path, which only exists
// when this var is absent. A contributor who's set it locally (e.g. to
// exercise encrypted upstream credentials by hand) would otherwise see those
// tests fail with no obvious link back to their own .env.
const testEnv = { ...process.env };
delete testEnv.SESSION_COOKIE_SECURE;
delete testEnv.SECRET_ENCRYPTION_KEY;

// `--full` additionally runs the CI jobs that live OUTSIDE the `test` job.
// Default `check` deliberately mirrors `test` alone (see CLAUDE.md); this flag
// exists because "check is green" was never the same claim as "CI is green".
const full = process.argv.includes("--full");

interface Step {
  label: string;
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /**
   * External binary this step needs. When it is missing the step is SKIPPED
   * with a visible notice rather than failing — these gates still run in CI,
   * so a local machine without helm or docker should not be blocked. The
   * notice matters: a silently-dropped step would make `check:full` claim
   * more coverage than it delivered.
   */
  requires?: string;
}

const steps: Step[] = [
  // Generated-artifact freshness first: it is the cheapest step here and it
  // fails on a class of drift nothing else can see — a source edit whose
  // derived copy (admin-ui's connectTemplates mirror, the error-code reference
  // docs) was never regenerated. Everything downstream would pass happily on
  // the stale copy, which is exactly how the two connect-template files ended
  // up diverging while every gate stayed green.
  { label: "generated artifacts", cmd: [bunExe, "run", "generate:check"], cwd: root },
  // Format/lint run first and cheap-first: a formatting or lint error is
  // usually faster to spot and fix than waiting on typecheck/tests/build.
  { label: "format check", cmd: [bunExe, "run", "format:check"], cwd: root },
  { label: "lint (root)", cmd: [bunExe, "run", "lint"], cwd: root },
  { label: "lint (admin-ui)", cmd: [bunExe, "run", "lint"], cwd: `${root}/admin-ui` },
  // Locale parity: en.json ↔ es.json (and any future locale) must have identical
  // key trees, or a missing translation silently falls back to the source locale
  // at runtime. Cheaper than a typecheck, fails earlier in the pipeline.
  { label: "i18n parity", cmd: [bunExe, "run", "lint:i18n"], cwd: `${root}/admin-ui` },
  { label: "root typecheck", cmd: [bunExe, "run", "typecheck"], cwd: root },
  // typecheck:tools covers scripts/ + e2e/ (tsconfig.tools.json); the root
  // typecheck above only includes src/. CI runs this as its own gate, so
  // `check` must too — otherwise a type error in a script or e2e spec passes
  // locally and only surfaces in CI (the local↔CI drift this script exists to
  // prevent).
  { label: "typecheck (tools)", cmd: [bunExe, "run", "typecheck:tools"], cwd: root },
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
    // --coverage so the backend coverage floor (bunfig.toml) is enforced here
    // too, not only in CI — otherwise a coverage regression that fails CI passes
    // this local aggregate check silently (the admin-ui step already uses
    // test:coverage; this keeps the two halves symmetric).
    label: "root tests",
    cmd: [bunExe, "test", "--coverage", "--path-ignore-patterns={admin-ui,e2e}/**"],
    cwd: root,
    env: testEnv,
  },
  { label: "admin-ui typecheck", cmd: [bunExe, "run", "typecheck"], cwd: `${root}/admin-ui` },
  { label: "admin-ui tests", cmd: [bunExe, "run", "test:coverage"], cwd: `${root}/admin-ui` },
  { label: "admin-ui build", cmd: [bunExe, "run", "build"], cwd: `${root}/admin-ui` },
];

// ---------------------------------------------------------------------------
// --full: the other CI gates.
//
// CI runs nine jobs; everything above only reproduces `test`. The rest are
// reproducible locally except for the two that need a container/toolchain, and
// those are skipped-with-a-notice rather than silently dropped.
//
// commitlint is deliberately NOT here: the lefthook `commit-msg` hook already
// validates every commit as it is written, so by the time you run this there is
// nothing left for it to catch. CI's job re-checks the PR range because a
// commit can reach GitHub without ever passing through a local hook.
//
// e2e, docker-build and the Windows test leg are also absent: e2e has its own
// `bun run test:e2e` (it boots a browser and a real backend — too heavy to fold
// into an aggregate check), docker-build needs a full image build, and the
// Windows leg is a platform, not a command.
// ---------------------------------------------------------------------------
if (full) {
  steps.push(
    // Instant, and catches a real drift class: the Bun version is repeated
    // across package.json, .bun-version, the Dockerfile and CI.
    { label: "version parity", cmd: [bunExe, "scripts/check-version-parity.ts"], cwd: root },
    { label: "docs build", cmd: [bunExe, "run", "docs:build"], cwd: `${root}/docs` },
    { label: "helm lint", cmd: ["helm", "lint", "helm/mcp-rest-bridge"], cwd: root, requires: "helm" },
    {
      label: "helm template (defaults)",
      cmd: ["helm", "template", "mcp-rest-bridge", "helm/mcp-rest-bridge"],
      cwd: root,
      requires: "helm",
    },
    {
      label: "helm template (existingSecret + persistence + external SA)",
      cmd: [
        "helm",
        "template",
        "mcp-rest-bridge",
        "helm/mcp-rest-bridge",
        "--set",
        "existingSecret=mcp-rest-bridge-external-secret",
        "--set",
        "persistence.enabled=true",
        "--set",
        "serviceAccount.create=false",
        "--set",
        "serviceAccount.name=mcp-rest-bridge-external-sa",
      ],
      cwd: root,
      requires: "helm",
    },
    {
      // promtool is not a normal install, so CI reaches it through the pinned
      // Prometheus image; mirror that exactly rather than requiring a local
      // promtool that would drift from the version CI validates against.
      // --entrypoint is load-bearing: the image's entrypoint is /bin/prometheus,
      // so a trailing `promtool ...` would be parsed as arguments to prometheus.
      label: "promtool check rules",
      cmd: [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "promtool",
        "-v",
        // Normalised: import.meta.dir yields backslashes on Windows, and a
        // `-v C:\a\b\scripts\..\monitoring:/rules` mount is not something to
        // hand Docker and hope. Spawning by argv (not through a shell) is what
        // keeps the CONTAINER-side `/rules` intact — Git Bash would otherwise
        // rewrite it to C:/Program Files/Git/rules before docker ever saw it.
        `${dockerRoot}/monitoring:/rules`,
        "prom/prometheus:v3.8.1",
        "check",
        "rules",
        "/rules/prometheus/alerts.yaml",
      ],
      cwd: root,
      requires: "docker",
    },
  );
}

/** True when `bin` is resolvable on PATH. */
async function hasBinary(bin: string): Promise<boolean> {
  const probe = Bun.spawn([process.platform === "win32" ? "where" : "which", bin], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  return (await probe.exited) === 0;
}

const skipped: string[] = [];

for (const step of steps) {
  if (step.requires && !(await hasBinary(step.requires))) {
    console.log(`\n[check] ⊘ ${step.label} — skipped, \`${step.requires}\` not on PATH (CI still gates this)`);
    skipped.push(`${step.label} (needs ${step.requires})`);
    continue;
  }
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

console.log(`\n[check] all checks passed${full ? " (--full)" : ""}`);
if (skipped.length > 0) {
  console.log(`[check] ${skipped.length} step(s) skipped for missing tooling: ${skipped.join(", ")}`);
}
if (!full) {
  console.log("[check] this mirrors CI's `test` job only — run `bun run check:full` for the other gates");
}
