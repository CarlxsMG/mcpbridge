import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  ADMIN_UI_PACKAGE_JSON,
  assertValidSemver,
  bumpChangelog,
  bumpChartAppVersion,
  bumpComposeImageTag,
  bumpPackageJsonVersion,
  CHANGELOG_MD,
  CHART_YAML,
  DATE_PLACEHOLDER,
  DOCKER_COMPOSE_YML,
  DOCS_PACKAGE_JSON,
  InvalidVersionError,
  ROOT_PACKAGE_JSON,
} from "../bump-version.js";

// ---------------------------------------------------------------------------
// scripts/bump-version.ts — exercises the pure string-transformation
// functions directly against in-memory fixtures (and read-only snapshots of
// the real files). Nothing here ever calls writeFileSync, so running this
// suite never touches the real package.json/Chart.yaml/CHANGELOG.md.
// ---------------------------------------------------------------------------

describe("assertValidSemver", () => {
  test("accepts a plain semver", () => {
    expect(assertValidSemver("1.1.0")).toBe("1.1.0");
    expect(assertValidSemver("0.1.0")).toBe("0.1.0");
    expect(assertValidSemver("10.20.30")).toBe("10.20.30");
  });

  test("accepts pre-release and build-metadata forms", () => {
    expect(assertValidSemver("1.1.0-beta.1")).toBe("1.1.0-beta.1");
    expect(assertValidSemver("1.1.0+build.5")).toBe("1.1.0+build.5");
    expect(assertValidSemver("1.1.0-rc.1+build.5")).toBe("1.1.0-rc.1+build.5");
  });

  test("rejects an empty string", () => {
    expect(() => assertValidSemver("")).toThrow(InvalidVersionError);
  });

  test("rejects a leading 'v' with a specific, actionable message", () => {
    expect(() => assertValidSemver("v1.1.0")).toThrow(InvalidVersionError);
    try {
      assertValidSemver("v1.1.0");
      throw new Error("expected assertValidSemver to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidVersionError);
      expect((err as Error).message).toContain("v");
      expect((err as Error).message).toContain("1.1.0");
    }
  });

  test("rejects malformed semver strings", () => {
    for (const bad of ["1.1", "1", "1.1.1.1", "abc", "1.1.x", "1.01.0", "1.1.0-", "1.1.0."]) {
      expect(() => assertValidSemver(bad)).toThrow(InvalidVersionError);
    }
  });
});

describe("bumpPackageJsonVersion", () => {
  const fixture = ["{", '  "name": "some-pkg",', '  "version": "1.0.0",', '  "type": "module",', "}"].join("\n");

  test("replaces only the version value, preserving indentation/quotes/trailing comma", () => {
    const result = bumpPackageJsonVersion(fixture, "1.1.0");
    expect(result).toContain('"version": "1.1.0",');
    expect(result).not.toContain('"version": "1.0.0"');
    // Every other line is byte-for-byte unchanged.
    expect(result).toContain('"name": "some-pkg",');
    expect(result).toContain('"type": "module",');
  });

  test("changes exactly one line", () => {
    const before = fixture.split("\n");
    const after = bumpPackageJsonVersion(fixture, "1.1.0").split("\n");
    expect(after).toHaveLength(before.length);
    const diffLines = after.filter((line, i) => line !== before[i]);
    expect(diffLines).toEqual(['  "version": "1.1.0",']);
  });

  test("throws a clear error when no version field is present", () => {
    expect(() => bumpPackageJsonVersion('{\n  "name": "x"\n}', "1.1.0")).toThrow(/version/i);
  });

  test("works against the real root/admin-ui/docs package.json contents (read-only)", () => {
    for (const path of [ROOT_PACKAGE_JSON, ADMIN_UI_PACKAGE_JSON, DOCS_PACKAGE_JSON]) {
      const real = readFileSync(path, "utf8");
      const bumped = bumpPackageJsonVersion(real, "99.99.99");
      expect(bumped).toContain('"version": "99.99.99"');
      // JSON stays parseable — no reserialization/formatting damage.
      expect(() => JSON.parse(bumped)).not.toThrow();
      const parsed = JSON.parse(bumped) as { version: string };
      expect(parsed.version).toBe("99.99.99");
      // Nothing outside the version line changed.
      const realLines = real.split("\n");
      const bumpedLines = bumped.split("\n");
      expect(bumpedLines).toHaveLength(realLines.length);
      const changedLines = bumpedLines.filter((line, i) => line !== realLines[i]);
      expect(changedLines).toHaveLength(1);
      expect(changedLines[0]).toContain('"version": "99.99.99"');
    }
  });
});

describe("bumpChartAppVersion", () => {
  const fixture = [
    "apiVersion: v2",
    "name: mcp-rest-bridge",
    "type: application",
    "# Chart version (bump on any template/values change).",
    "version: 0.1.0",
    '# Tracks the app\'s package.json "version" — bump alongside it.',
    'appVersion: "1.0.0"',
    "home: https://example.invalid",
  ].join("\n");

  test("updates appVersion only, leaving the chart's own version field untouched", () => {
    const result = bumpChartAppVersion(fixture, "1.1.0");
    expect(result).toContain('appVersion: "1.1.0"');
    expect(result).not.toContain('appVersion: "1.0.0"');
    // Chart's own packaging version is a different field/concern — must survive unchanged.
    expect(result).toContain("version: 0.1.0");
  });

  test("normalizes an unquoted appVersion to quoted form", () => {
    const unquoted = fixture.replace('appVersion: "1.0.0"', "appVersion: 1.0.0");
    const result = bumpChartAppVersion(unquoted, "1.1.0");
    expect(result).toContain('appVersion: "1.1.0"');
  });

  test("throws a clear error when no appVersion field is present", () => {
    expect(() => bumpChartAppVersion("apiVersion: v2\nname: foo\n", "1.1.0")).toThrow(/appVersion/);
  });

  test("works against the real Chart.yaml contents (read-only)", () => {
    const real = readFileSync(CHART_YAML, "utf8");
    const bumped = bumpChartAppVersion(real, "99.99.99");
    expect(bumped).toContain('appVersion: "99.99.99"');
    // The chart's own `version:` line must be byte-for-byte unchanged.
    const chartVersionLine = real.split("\n").find((l) => /^version:/.test(l));
    expect(chartVersionLine).toBeDefined();
    expect(bumped).toContain(chartVersionLine as string);
  });
});

describe("bumpComposeImageTag", () => {
  const fixture = [
    "services:",
    "  gateway:",
    "    image: ghcr.io/acme/mcpbridge:${MCPBRIDGE_VERSION:-1.0.0}",
    "    restart: unless-stopped",
  ].join("\n");

  test("updates the default tag inside the ${MCPBRIDGE_VERSION:-...} expansion", () => {
    const result = bumpComposeImageTag(fixture, "1.1.0");
    expect(result).toContain("mcpbridge:${MCPBRIDGE_VERSION:-1.1.0}");
    expect(result).not.toContain("1.0.0");
    // The rest of the line (registry/repo, restart policy) survives unchanged.
    expect(result).toContain("restart: unless-stopped");
  });

  test("throws a clear error when there's no MCPBRIDGE_VERSION default to replace", () => {
    expect(() => bumpComposeImageTag("services:\n  gateway:\n    image: nginx:latest\n", "1.1.0")).toThrow(
      /MCPBRIDGE_VERSION/,
    );
  });

  test("works against the real docker-compose.yml (read-only)", () => {
    const real = readFileSync(DOCKER_COMPOSE_YML, "utf8");
    const bumped = bumpComposeImageTag(real, "99.99.99");
    expect(bumped).toContain("${MCPBRIDGE_VERSION:-99.99.99}");
  });
});

describe("bumpChangelog", () => {
  const fixture = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Something new.",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
    "- A bug fix.",
    "",
    "## [1.0.0] - 2026-07-03",
    "",
    "Initial release.",
    "",
    "[Unreleased]: https://github.com/example/repo/compare/v1.0.0...HEAD",
    "[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0",
    "",
  ].join("\n");

  test("renames Unreleased into a dated version section and inserts a fresh empty Unreleased above it", () => {
    const { content, oldVersion } = bumpChangelog(fixture, "1.1.0");
    expect(oldVersion).toBe("1.0.0");

    const unreleasedIdx = content.indexOf("## [Unreleased]");
    const newSectionIdx = content.indexOf(`## [1.1.0] - ${DATE_PLACEHOLDER}`);
    const oldSectionIdx = content.indexOf("## [1.0.0] - 2026-07-03");

    expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
    expect(newSectionIdx).toBeGreaterThan(unreleasedIdx);
    expect(oldSectionIdx).toBeGreaterThan(newSectionIdx);

    // Exactly one Unreleased heading remains (the fresh empty one) — the old
    // one was renamed, not duplicated.
    expect(content.match(/## \[Unreleased\]/g)).toHaveLength(1);

    // The fresh Unreleased section has empty Added/Changed/Fixed placeholders.
    const freshBlock = content.slice(unreleasedIdx, newSectionIdx);
    expect(freshBlock).toContain("### Added");
    expect(freshBlock).toContain("### Changed");
    expect(freshBlock).toContain("### Fixed");
    expect(freshBlock).not.toContain("Something new");
    expect(freshBlock).not.toContain("A bug fix");

    // The renamed section carries over the original Unreleased body verbatim.
    const renamedBlock = content.slice(newSectionIdx, oldSectionIdx);
    expect(renamedBlock).toContain("- Something new.");
    expect(renamedBlock).toContain("- A bug fix.");
  });

  test("rewrites the compare-link footer and adds a new release-tag link", () => {
    const { content } = bumpChangelog(fixture, "1.1.0");
    expect(content).toContain("[Unreleased]: https://github.com/example/repo/compare/v1.1.0...HEAD");
    expect(content).toContain("[1.1.0]: https://github.com/example/repo/releases/tag/v1.1.0");
    // Old release's own tag link must survive unchanged.
    expect(content).toContain("[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0");
    // The stale compare link (pointing at the old version) must be gone.
    expect(content).not.toContain("compare/v1.0.0...HEAD");
  });

  test("produces well-formed, parseable markdown headings in the expected order", () => {
    const { content } = bumpChangelog(fixture, "1.1.0");
    const headings = [...content.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual(["## [Unreleased]", "## [1.1.0] - YYYY-MM-DD", "## [1.0.0] - 2026-07-03"]);
  });

  test("throws when there is no [Unreleased] heading", () => {
    const broken = fixture.replace("## [Unreleased]", "## Not Unreleased");
    expect(() => bumpChangelog(broken, "1.1.0")).toThrow(/Unreleased/);
  });

  test("throws when there is no released section after [Unreleased]", () => {
    const broken = fixture.slice(0, fixture.indexOf("## [1.0.0]"));
    expect(() => bumpChangelog(broken, "1.1.0")).toThrow(/released/i);
  });

  test("throws when the footer has no compare link to rewrite", () => {
    const broken = fixture.replace("[Unreleased]: https://github.com/example/repo/compare/v1.0.0...HEAD\n", "");
    expect(() => bumpChangelog(broken, "1.1.0")).toThrow(/footer/i);
  });

  test("works against the real CHANGELOG.md contents (read-only) and stays well-formed", () => {
    const real = readFileSync(CHANGELOG_MD, "utf8");
    const { content, oldVersion } = bumpChangelog(real, "99.99.99");

    expect(oldVersion).toBe("1.0.0");
    expect(content).toContain(`## [99.99.99] - ${DATE_PLACEHOLDER}`);
    expect(content.match(/## \[Unreleased\]/g)).toHaveLength(1);
    expect(content).toContain("[Unreleased]: https://github.com/CarlxsMG/mcpbridge/compare/v99.99.99...HEAD");
    expect(content).toContain("[99.99.99]: https://github.com/CarlxsMG/mcpbridge/releases/tag/v99.99.99");
    // Original 1.0.0 release section/link must survive untouched.
    expect(content).toContain("## [1.0.0] - 2026-07-03");
    expect(content).toContain("[1.0.0]: https://github.com/CarlxsMG/mcpbridge/releases/tag/v1.0.0");

    // Headings still nest in strictly descending "recency" order: fresh
    // Unreleased, then the newly-cut version, then every prior release.
    const headings = [...content.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings[0]).toBe("## [Unreleased]");
    expect(headings[1]).toBe(`## [99.99.99] - ${DATE_PLACEHOLDER}`);
    expect(headings).toContain("## [1.0.0] - 2026-07-03");
  });
});
