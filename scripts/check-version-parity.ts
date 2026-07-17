#!/usr/bin/env bun
/**
 * Version-parity gate. The project version ("1.0.0" today) is duplicated across
 * several files that scripts/bump-version.ts keeps in sync when cutting a
 * release — but nothing re-checked that they STAYED in sync afterwards, so a
 * hand-edit to any one of them (or a half-finished bump) would ship a mismatched
 * set unnoticed.
 *
 * This reads the version out of each source and fails if they diverge:
 *   - root package.json         "version"
 *   - admin-ui/package.json     "version"
 *   - docs/package.json         "version"
 *   - helm/.../Chart.yaml       appVersion  (NOT the chart's own `version:`, a
 *                                            deliberately separate concern — see
 *                                            bump-version.ts's bumpChartAppVersion)
 *   - docker-compose.yml        the ${MCPBRIDGE_VERSION:-<tag>} default image tag
 *
 * The pure string-extraction functions are exported for the unit tests; main()
 * only reads files (never writes) and exits non-zero on a mismatch. The file
 * paths are reused from bump-version.ts so the two scripts can't drift apart on
 * WHERE the version lives. Wired into ci.yml as the `version-parity` job.
 */
import { readFileSync } from "node:fs";

import {
  ADMIN_UI_PACKAGE_JSON,
  CHART_YAML,
  DOCKER_COMPOSE_YML,
  DOCS_PACKAGE_JSON,
  ROOT_PACKAGE_JSON,
} from "./bump-version.js";

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

function main(): void {
  let sources: VersionSource[];
  try {
    sources = readVersionSources();
  } catch (err) {
    console.error(`[check-version-parity] error: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = checkParity(sources);

  console.log("[check-version-parity] version references:");
  for (const source of sources) {
    console.log(`  ${source.version.padEnd(12)} ${source.label}`);
  }

  if (result.ok) {
    console.log(`\n[check-version-parity] ✓ all ${sources.length} version references agree: ${result.version}`);
    return;
  }

  console.error("\n[check-version-parity] ✗ version mismatch — these files disagree:");
  for (const [version, group] of result.byVersion) {
    console.error(`  ${version}:`);
    for (const source of group) {
      console.error(`    - ${source.label} (${source.path})`);
    }
  }
  console.error("\nRun `bun scripts/bump-version.ts <version>` to re-sync them, or fix the outlier by hand.");
  process.exit(1);
}

if (import.meta.main) {
  main();
}
