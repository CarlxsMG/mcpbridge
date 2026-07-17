#!/usr/bin/env bun
/**
 * Version-parity gate. Two independent sets of duplicated version strings each
 * have to stay internally consistent, and nothing re-checked that they STAYED
 * in sync — a hand-edit to any one file (or a half-finished bump) would ship a
 * mismatched set unnoticed.
 *
 * 1. The **app version** ("1.0.0" today), which scripts/bump-version.ts keeps in
 *    sync when cutting a release:
 *   - root package.json         "version"
 *   - admin-ui/package.json     "version"
 *   - docs/package.json         "version"
 *   - helm/.../Chart.yaml       appVersion  (NOT the chart's own `version:`, a
 *                                            deliberately separate concern — see
 *                                            bump-version.ts's bumpChartAppVersion)
 *   - docker-compose.yml        the ${MCPBRIDGE_VERSION:-<tag>} default image tag
 *
 * 2. The **Bun runtime version** ("1.3.11" today) — the more consequential drift,
 *    since a mismatch here means CI, the dev container, the type definitions, and
 *    the published image can build against different Bun releases (CLAUDE.md pins
 *    bun-types exactly for this reason). These have no bump script, so this gate
 *    is the only thing holding them together:
 *   - .bun-version             the file CI's setup-bun reads via bun-version-file
 *   - root package.json        "packageManager" ("bun@<version>")
 *   - admin-ui/package.json    "packageManager"
 *   - docs/package.json        "packageManager"
 *   - root package.json        the exact-pinned "bun-types" devDependency
 *   - Dockerfile               ARG BUN_VERSION default (the base-image tag)
 *
 * The pure string-extraction functions are exported for the unit tests; main()
 * only reads files (never writes) and exits non-zero if EITHER set diverges. The
 * app-version paths are reused from bump-version.ts so the two scripts can't
 * drift apart on WHERE the version lives. Wired into ci.yml as the
 * `version-parity` job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ADMIN_UI_PACKAGE_JSON,
  CHART_YAML,
  DOCKER_COMPOSE_YML,
  DOCS_PACKAGE_JSON,
  ROOT_PACKAGE_JSON,
} from "./bump-version.js";

/** The Bun-runtime-version sources live outside bump-version.ts's remit (it only
 * touches the app version), so their paths are derived here from the repo root. */
const ROOT = join(import.meta.dir, "..");
export const BUN_VERSION_FILE = join(ROOT, ".bun-version");
export const DOCKERFILE = join(ROOT, "Dockerfile");

export interface VersionSource {
  /** Human-readable name for the mismatch report. */
  label: string;
  /** Absolute path the version was read from. */
  path: string;
  /** The version string found in that file. */
  version: string;
}

/**
 * Reads the top-level `"version"` string out of a package.json's raw text.
 * Uses JSON.parse (these files are always valid JSON) and narrows the result,
 * throwing a clear, source-labelled error if the field is missing or non-string
 * so a structural change surfaces loudly instead of silently passing the gate.
 */
export function extractPackageJsonVersion(content: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${(err as Error).message})`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error(`${label}: no top-level "version" field`);
  }
  const { version } = parsed as { version: unknown };
  if (typeof version !== "string") {
    throw new Error(`${label}: "version" is not a string`);
  }
  return version;
}

/**
 * Reads Chart.yaml's `appVersion` (quoted or not), stripping surrounding double
 * quotes. Deliberately does NOT read the chart's own `version:` field — that
 * tracks template/values changes, a separate concern from the app version (see
 * bump-version.ts's bumpChartAppVersion for the full reasoning).
 */
export function extractChartAppVersion(content: string): string {
  // `.+?` won't cross a `\r`/`\n` (JS `.` excludes line terminators), and the
  // trailing class tolerates a CRLF `\r` before the multiline `$`.
  const match = /^appVersion:[ \t]*(.+?)[ \t\r]*$/m.exec(content);
  if (!match) {
    throw new Error('Chart.yaml: no "appVersion" field');
  }
  return match[1].replace(/^"(.*)"$/, "$1");
}

/**
 * Reads the default image tag out of docker-compose.yml's
 * `image: ...:${MCPBRIDGE_VERSION:-<tag>}` parameter expansion — the value a
 * fresh `docker compose up` uses when MCPBRIDGE_VERSION isn't set.
 */
export function extractComposeDefaultTag(content: string): string {
  const match = /\$\{MCPBRIDGE_VERSION:-([^}]*)\}/.exec(content);
  if (!match) {
    throw new Error('docker-compose.yml: no "${MCPBRIDGE_VERSION:-<tag>}" default image tag');
  }
  return match[1];
}

/**
 * Reads the bare Bun version out of a `.bun-version` file — its entire content,
 * trimmed of surrounding whitespace/newline. This is the single source of truth
 * CI's `oven-sh/setup-bun` reads via `bun-version-file`.
 */
export function extractBunVersionFile(content: string): string {
  const version = content.trim();
  if (!version) {
    throw new Error(".bun-version: file is empty");
  }
  return version;
}

/**
 * Reads the Bun version pinned in a package.json's `"packageManager"` field
 * (`"bun@1.3.11"` → `"1.3.11"`), tolerating a Corepack integrity suffix
 * (`bun@1.3.11+sha256.…`). Throws a source-labelled error if the field is
 * missing, non-string, or doesn't name Bun.
 */
export function extractPackageManagerBunVersion(content: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${(err as Error).message})`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || !("packageManager" in parsed)) {
    throw new Error(`${label}: no top-level "packageManager" field`);
  }
  const { packageManager } = parsed as { packageManager: unknown };
  if (typeof packageManager !== "string") {
    throw new Error(`${label}: "packageManager" is not a string`);
  }
  const match = /^bun@([^+\s]+)/.exec(packageManager);
  if (!match) {
    throw new Error(`${label}: "packageManager" is not a "bun@<version>" spec (got "${packageManager}")`);
  }
  return match[1];
}

/**
 * Reads the `bun-types` dependency version out of a package.json (looking in
 * `devDependencies` then `dependencies`). CLAUDE.md pins this EXACTLY (no `^`)
 * so it matches `packageManager`/`.bun-version`; returning the raw spec means an
 * accidental range prefix (e.g. `^1.3.11`) trips the gate too, which is the
 * intent. Throws a source-labelled error if the dependency is absent or
 * non-string.
 */
export function extractBunTypesVersion(content: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${(err as Error).message})`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${label}: not a JSON object`);
  }
  const pkg = parsed as { dependencies?: unknown; devDependencies?: unknown };
  for (const bucket of [pkg.devDependencies, pkg.dependencies]) {
    if (typeof bucket === "object" && bucket !== null && "bun-types" in bucket) {
      const value = (bucket as Record<string, unknown>)["bun-types"];
      if (typeof value !== "string") {
        throw new Error(`${label}: "bun-types" dependency is not a string`);
      }
      return value;
    }
  }
  throw new Error(`${label}: no "bun-types" dependency`);
}

/**
 * Reads the Bun version from the Dockerfile's `ARG BUN_VERSION=<version>`
 * default — the value `FROM oven/bun:${BUN_VERSION}-alpine…` resolves to when no
 * `--build-arg` overrides it.
 */
export function extractDockerfileBunVersion(content: string): string {
  const match = /^ARG[ \t]+BUN_VERSION=(\S+)[ \t\r]*$/m.exec(content);
  if (!match) {
    throw new Error('Dockerfile: no "ARG BUN_VERSION=<version>" default');
  }
  return match[1];
}

export interface ParityResult {
  /** True when every source carries the same version. */
  ok: boolean;
  /** The single agreed version when ok; undefined on a mismatch (or no sources). */
  version?: string;
  /** version string → the sources carrying it, for reporting a mismatch. */
  byVersion: Map<string, VersionSource[]>;
}

/** Groups sources by the version they carry; ok iff there's at most one group. */
export function checkParity(sources: VersionSource[]): ParityResult {
  const byVersion = new Map<string, VersionSource[]>();
  for (const source of sources) {
    const existing = byVersion.get(source.version);
    if (existing) {
      existing.push(source);
    } else {
      byVersion.set(source.version, [source]);
    }
  }
  const versions = [...byVersion.keys()];
  return { ok: versions.length <= 1, version: versions.length === 1 ? versions[0] : undefined, byVersion };
}

/** Reads the version out of every tracked source file (used by main + tests). */
export function readVersionSources(): VersionSource[] {
  return [
    {
      label: "root package.json",
      path: ROOT_PACKAGE_JSON,
      version: extractPackageJsonVersion(readFileSync(ROOT_PACKAGE_JSON, "utf8"), "root package.json"),
    },
    {
      label: "admin-ui/package.json",
      path: ADMIN_UI_PACKAGE_JSON,
      version: extractPackageJsonVersion(readFileSync(ADMIN_UI_PACKAGE_JSON, "utf8"), "admin-ui/package.json"),
    },
    {
      label: "docs/package.json",
      path: DOCS_PACKAGE_JSON,
      version: extractPackageJsonVersion(readFileSync(DOCS_PACKAGE_JSON, "utf8"), "docs/package.json"),
    },
    {
      label: "helm Chart.yaml [appVersion]",
      path: CHART_YAML,
      version: extractChartAppVersion(readFileSync(CHART_YAML, "utf8")),
    },
    {
      label: "docker-compose.yml [default image tag]",
      path: DOCKER_COMPOSE_YML,
      version: extractComposeDefaultTag(readFileSync(DOCKER_COMPOSE_YML, "utf8")),
    },
  ];
}

/** Reads the Bun runtime version out of every tracked source (used by main +
 * tests). Six references, all expected to carry the same Bun release. */
export function readBunVersionSources(): VersionSource[] {
  const rootPkg = readFileSync(ROOT_PACKAGE_JSON, "utf8");
  return [
    {
      label: ".bun-version",
      path: BUN_VERSION_FILE,
      version: extractBunVersionFile(readFileSync(BUN_VERSION_FILE, "utf8")),
    },
    {
      label: "root package.json [packageManager]",
      path: ROOT_PACKAGE_JSON,
      version: extractPackageManagerBunVersion(rootPkg, "root package.json"),
    },
    {
      label: "admin-ui/package.json [packageManager]",
      path: ADMIN_UI_PACKAGE_JSON,
      version: extractPackageManagerBunVersion(readFileSync(ADMIN_UI_PACKAGE_JSON, "utf8"), "admin-ui/package.json"),
    },
    {
      label: "docs/package.json [packageManager]",
      path: DOCS_PACKAGE_JSON,
      version: extractPackageManagerBunVersion(readFileSync(DOCS_PACKAGE_JSON, "utf8"), "docs/package.json"),
    },
    {
      label: "root package.json [bun-types]",
      path: ROOT_PACKAGE_JSON,
      version: extractBunTypesVersion(rootPkg, "root package.json"),
    },
    {
      label: "Dockerfile [ARG BUN_VERSION]",
      path: DOCKERFILE,
      version: extractDockerfileBunVersion(readFileSync(DOCKERFILE, "utf8")),
    },
  ];
}

/**
 * Runs one parity check over a labelled set of sources: prints the reference
 * table, then the ✓/✗ verdict (with the mismatch breakdown + a fix hint on
 * failure). Returns true iff every source in the set agrees.
 */
function reportParity(title: string, sources: VersionSource[], fixHint: string): boolean {
  const result = checkParity(sources);

  console.log(`[check-version-parity] ${title}:`);
  for (const source of sources) {
    console.log(`  ${source.version.padEnd(12)} ${source.label}`);
  }

  if (result.ok) {
    console.log(`[check-version-parity] ✓ all ${sources.length} references agree: ${result.version}\n`);
    return true;
  }

  console.error("[check-version-parity] ✗ mismatch — these files disagree:");
  for (const [version, group] of result.byVersion) {
    console.error(`  ${version}:`);
    for (const source of group) {
      console.error(`    - ${source.label} (${source.path})`);
    }
  }
  console.error(`${fixHint}\n`);
  return false;
}

function main(): void {
  let appSources: VersionSource[];
  let bunSources: VersionSource[];
  try {
    appSources = readVersionSources();
    bunSources = readBunVersionSources();
  } catch (err) {
    console.error(`[check-version-parity] error: ${(err as Error).message}`);
    process.exit(1);
  }

  const appOk = reportParity(
    "app version references",
    appSources,
    "Run `bun scripts/bump-version.ts <version>` to re-sync them, or fix the outlier by hand.",
  );
  const bunOk = reportParity(
    "Bun runtime version references",
    bunSources,
    "Update .bun-version, the three packageManager fields, root's bun-types, and the Dockerfile's " +
      "ARG BUN_VERSION together — they must all name the same Bun release.",
  );

  if (!appOk || !bunOk) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
