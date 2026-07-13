#!/usr/bin/env bun
/**
 * Bumps the project version everywhere it's duplicated, in one shot: root
 * package.json, admin-ui/package.json, docs/package.json, the Helm chart's
 * `appVersion`, docker-compose.yml's default image tag, and CHANGELOG.md's
 * `[Unreleased]` section + compare-link footer.
 *
 *   bun scripts/bump-version.ts 1.1.0
 *
 * Every update below is a *targeted* string replace against the exact
 * line(s)/section that hold the version — never a reserialize of the whole
 * file. In particular, `JSON.parse` + `JSON.stringify` on the package.json
 * files would silently reformat unrelated whitespace/key order and blow up
 * the diff, so those are done as line-anchored regex replaces instead.
 *
 * This script only edits the working tree. It deliberately never runs `git
 * commit`, `git tag`, or `git push` — that's a decision for the maintainer to
 * make after reviewing the diff (see the printed summary at the end of a run).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export const ROOT_PACKAGE_JSON = join(ROOT, "package.json");
export const ADMIN_UI_PACKAGE_JSON = join(ROOT, "admin-ui", "package.json");
export const DOCS_PACKAGE_JSON = join(ROOT, "docs", "package.json");
export const CHART_YAML = join(ROOT, "helm", "mcp-rest-bridge", "Chart.yaml");
export const DOCKER_COMPOSE_YML = join(ROOT, "docker-compose.yml");
export const CHANGELOG_MD = join(ROOT, "CHANGELOG.md");

/** Placeholder date written into a freshly-cut CHANGELOG.md section — this
 * script can't reliably call `new Date()` and have it mean "today" across
 * every environment/timezone it might run in, so it leaves an unmissable
 * placeholder and prints a reminder instead of guessing. */
export const DATE_PLACEHOLDER = "YYYY-MM-DD";

// ---------------------------------------------------------------------------
// Semver validation
// ---------------------------------------------------------------------------

// The reference regex from semver.org, unmodified.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class InvalidVersionError extends Error {}

/**
 * Validates `version` is a bare, well-formed semver (no `v` prefix — this is
 * the CLI arg shape; the script itself adds a `v` wherever a git-tag-style
 * reference is needed, e.g. CHANGELOG.md's compare links). Returns `version`
 * unchanged on success so call sites can validate-and-assign in one line;
 * throws {@link InvalidVersionError} with a human-readable reason otherwise.
 */
export function assertValidSemver(version: string): string {
  if (!version) {
    throw new InvalidVersionError("no version given");
  }
  if (/^v\d/i.test(version)) {
    throw new InvalidVersionError(
      `"${version}" has a "v" prefix — pass the bare semver (e.g. "1.1.0", not "v1.1.0"); ` +
        `this script adds "v" itself wherever a git-tag-style reference is needed`,
    );
  }
  if (!SEMVER_RE.test(version)) {
    throw new InvalidVersionError(`"${version}" is not a well-formed semver (expected e.g. "1.2.3" or "1.2.3-beta.1")`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// package.json (root, admin-ui, docs)
// ---------------------------------------------------------------------------

/**
 * Replaces a top-level `"version": "..."` field in a package.json's raw
 * text. Matches only a 2-space-indented top-level line (all three
 * package.json files this script touches are formatted that way) so this
 * can't accidentally hit a differently-indented/nested `"version"` key —
 * there isn't one today, but the anchor is cheap insurance. Every other byte
 * of the file (formatting, key order, trailing commas) is left untouched.
 */
export function bumpPackageJsonVersion(content: string, newVersion: string): string {
  const re = /^(\s{2}"version":\s*")[^"]*("\s*,?\s*)$/m;
  if (!re.test(content)) {
    throw new Error('could not find a top-level "version" field to replace');
  }
  return content.replace(re, `$1${newVersion}$2`);
}

// ---------------------------------------------------------------------------
// helm/mcp-rest-bridge/Chart.yaml
// ---------------------------------------------------------------------------

/**
 * Updates Chart.yaml's `appVersion` field only.
 *
 * Chart.yaml has two version-shaped fields, and they mean different things —
 * confirmed by reading the file's own comments before wiring this up:
 *   - `version` is the *chart's* packaging version ("bump on any
 *     template/values change"). That's a separate concern from the app
 *     version this script manages: a release of the app doesn't necessarily
 *     touch chart templates/values, and a chart-only fix doesn't bump the
 *     app. Auto-bumping it here would conflate the two, so it's deliberately
 *     left alone.
 *   - `appVersion` explicitly "tracks the app's package.json version — bump
 *     alongside it", which is exactly what this script does everywhere else.
 * If a release *also* changes chart templates/values, bump `version` by hand.
 */
export function bumpChartAppVersion(content: string, newVersion: string): string {
  const re = /^(appVersion:\s*)"?[^"\r\n]*"?[ \t]*$/m;
  if (!re.test(content)) {
    throw new Error('could not find an "appVersion" field in Chart.yaml to replace');
  }
  return content.replace(re, `$1"${newVersion}"`);
}

// ---------------------------------------------------------------------------
// docker-compose.yml
// ---------------------------------------------------------------------------

/**
 * Updates docker-compose.yml's DEFAULT image tag — the `1.0.0` fallback inside
 * `image: ...:${MCPBRIDGE_VERSION:-1.0.0}`. Without this, a fresh `docker compose
 * up` after a release keeps pulling the previous version unless the operator
 * happens to set MCPBRIDGE_VERSION (the Helm chart avoids this by defaulting
 * image.tag to .Chart.AppVersion, which this script already bumps — compose was
 * the lone outlier). Matches only the `:-<tag>}` default inside the parameter
 * expansion, so an explicit MCPBRIDGE_VERSION override at runtime is untouched.
 */
export function bumpComposeImageTag(content: string, newVersion: string): string {
  const re = /(\$\{MCPBRIDGE_VERSION:-)[^}]*(\})/;
  if (!re.test(content)) {
    throw new Error('could not find a "${MCPBRIDGE_VERSION:-<tag>}" default image tag in docker-compose.yml');
  }
  return content.replace(re, `$1${newVersion}$2`);
}

// ---------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------

export interface ChangelogBumpResult {
  content: string;
  /** The version previously at the top of the changelog, read out of the
   * existing `[Unreleased]: .../compare/vX...HEAD` footer link. */
  oldVersion: string;
}

/**
 * Renames the `## [Unreleased]` section to `## [<newVersion>] - <date>`,
 * inserts a fresh empty `## [Unreleased]` section above it, and rewrites the
 * compare-link footer to match.
 *
 * The "previous top version" isn't a parameter — it's read out of the
 * existing `[Unreleased]: .../compare/vX.Y.Z...HEAD` footer link, which this
 * same script always keeps in sync with the last release. That link is the
 * single source of truth for "what came before", so there's nothing to pass
 * in and nothing that can drift out of sync with it.
 */
export function bumpChangelog(
  content: string,
  newVersion: string,
  datePlaceholder: string = DATE_PLACEHOLDER,
): ChangelogBumpResult {
  const unreleasedHeadingRe = /^## \[Unreleased\]\s*$/m;
  const headingMatch = unreleasedHeadingRe.exec(content);
  if (!headingMatch) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" heading to rename');
  }
  const headingStart = headingMatch.index;
  const headingEnd = headingStart + headingMatch[0].length;

  // The "body" is everything between the "## [Unreleased]" heading and the
  // next "## [" heading (the most recently released version) — the block of
  // ### Added/### Changed/### Fixed content that becomes the new version's
  // section verbatim.
  const afterHeading = content.slice(headingEnd);
  const nextHeadingRe = /^## \[/m;
  const nextHeadingMatch = nextHeadingRe.exec(afterHeading);
  if (!nextHeadingMatch) {
    throw new Error('CHANGELOG.md has no released "## [" section after "## [Unreleased]" to anchor the rename on');
  }
  const unreleasedBody = afterHeading.slice(0, nextHeadingMatch.index);
  const bodyEnd = headingEnd + nextHeadingMatch.index;

  const footerRe = /^\[Unreleased\]:\s*(\S+?)\/compare\/v([0-9A-Za-z.\-+]+)\.\.\.HEAD[ \t]*$/m;
  const footerMatch = footerRe.exec(content);
  if (!footerMatch) {
    throw new Error('CHANGELOG.md footer has no "[Unreleased]: .../compare/vX.Y.Z...HEAD" link to rewrite');
  }
  const [oldFooterLine, repoUrl, oldVersion] = footerMatch;

  const freshUnreleased = `## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n\n`;
  const renamedSection = `## [${newVersion}] - ${datePlaceholder}${unreleasedBody}`;

  const newFooterBlock = `[Unreleased]: ${repoUrl}/compare/v${newVersion}...HEAD\n[${newVersion}]: ${repoUrl}/releases/tag/v${newVersion}`;

  const withRenamedSection = content.slice(0, headingStart) + freshUnreleased + renamedSection + content.slice(bodyEnd);
  const withNewFooter = withRenamedSection.replace(oldFooterLine, newFooterBlock);
  if (withNewFooter === withRenamedSection) {
    // Should be unreachable (the regex above just matched this exact text
    // in the original content, and nothing before bodyEnd touches the
    // footer), but fail loudly rather than silently skip the footer update.
    throw new Error("failed to rewrite CHANGELOG.md's compare-link footer");
  }

  return { content: withNewFooter, oldVersion };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "[bump-version] error: no version given.\n\n" +
        "Usage: bun scripts/bump-version.ts <new-version>\n" +
        "  e.g. bun scripts/bump-version.ts 1.1.0",
    );
    process.exit(1);
  }

  let newVersion: string;
  try {
    newVersion = assertValidSemver(arg);
  } catch (err) {
    console.error(`[bump-version] error: ${(err as Error).message}`);
    process.exit(1);
  }

  const changed: string[] = [];

  for (const [label, path] of [
    ["root package.json", ROOT_PACKAGE_JSON],
    ["admin-ui/package.json", ADMIN_UI_PACKAGE_JSON],
    ["docs/package.json", DOCS_PACKAGE_JSON],
  ] as const) {
    const before = readFileSync(path, "utf8");
    const after = bumpPackageJsonVersion(before, newVersion);
    if (after !== before) {
      writeFileSync(path, after, "utf8");
      changed.push(`${label} (${path})`);
    } else {
      console.log(`[bump-version] ${label} already at "${newVersion}" — left untouched`);
    }
  }

  {
    const before = readFileSync(CHART_YAML, "utf8");
    const after = bumpChartAppVersion(before, newVersion);
    if (after !== before) {
      writeFileSync(CHART_YAML, after, "utf8");
      changed.push(`helm/mcp-rest-bridge/Chart.yaml [appVersion] (${CHART_YAML})`);
    } else {
      console.log(`[bump-version] Chart.yaml appVersion already "${newVersion}" — left untouched`);
    }
    console.log(
      "[bump-version] note: Chart.yaml's \"version\" field (the chart's own packaging version) was left " +
        "untouched on purpose — per its own comment it tracks template/values changes, not the app version. " +
        "Bump it by hand too if this release also changed the chart.",
    );
  }

  {
    const before = readFileSync(DOCKER_COMPOSE_YML, "utf8");
    const after = bumpComposeImageTag(before, newVersion);
    if (after !== before) {
      writeFileSync(DOCKER_COMPOSE_YML, after, "utf8");
      changed.push(`docker-compose.yml [default image tag] (${DOCKER_COMPOSE_YML})`);
    } else {
      console.log(`[bump-version] docker-compose.yml default image tag already "${newVersion}" — left untouched`);
    }
  }

  {
    const before = readFileSync(CHANGELOG_MD, "utf8");
    let result: ChangelogBumpResult;
    try {
      result = bumpChangelog(before, newVersion);
    } catch (err) {
      console.error(`[bump-version] error updating CHANGELOG.md: ${(err as Error).message}`);
      process.exit(1);
    }
    if (result.oldVersion === newVersion) {
      console.warn(
        `[bump-version] warning: CHANGELOG.md's previous top version is already "${newVersion}" — is this bump correct?`,
      );
    }
    writeFileSync(CHANGELOG_MD, result.content, "utf8");
    changed.push(`CHANGELOG.md (${CHANGELOG_MD})`);
  }

  console.log(`\n[bump-version] bumped version → ${newVersion}. Files changed:`);
  for (const c of changed) {
    console.log(`  - ${c}`);
  }
  console.log(`\n[bump-version] you still need to:`);
  console.log(`  1. Open CHANGELOG.md and replace the "${DATE_PLACEHOLDER}" placeholder with the real release date,`);
  console.log(`     and double-check the section content that got carried over from [Unreleased].`);
  console.log(`  2. Review the full diff (git diff).`);
  console.log(`  3. Commit, then tag and push yourself — this script never does either:`);
  console.log(`       git add -A && git commit -m "chore(release): v${newVersion}"`);
  console.log(`       git tag v${newVersion}`);
  console.log(`       git push && git push --tags`);
}

if (import.meta.main) {
  main();
}
