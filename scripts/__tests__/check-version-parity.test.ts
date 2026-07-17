import { describe, expect, test } from "bun:test";

import {
  checkParity,
  extractChartAppVersion,
  extractComposeDefaultTag,
  extractPackageJsonVersion,
  readVersionSources,
  type VersionSource,
} from "../check-version-parity.js";

// ---------------------------------------------------------------------------
// scripts/check-version-parity.ts — exercises the pure extraction/grouping
// functions against in-memory fixtures, plus a read-only assertion that the
// real tree is currently in parity. Nothing here writes a file.
// ---------------------------------------------------------------------------

describe("extractPackageJsonVersion", () => {
  test("reads a top-level version string", () => {
    expect(extractPackageJsonVersion('{ "name": "x", "version": "1.2.3" }', "x")).toBe("1.2.3");
  });

  test("throws on invalid JSON", () => {
    expect(() => extractPackageJsonVersion("{ not json", "x")).toThrow(/valid JSON/);
  });

  test("throws when there is no version field", () => {
    expect(() => extractPackageJsonVersion('{ "name": "x" }', "x")).toThrow(/version/);
  });

  test("throws when version is not a string", () => {
    expect(() => extractPackageJsonVersion('{ "version": 123 }', "x")).toThrow(/string/);
  });
});

describe("extractChartAppVersion", () => {
  test("reads a quoted appVersion", () => {
    expect(extractChartAppVersion('name: c\nappVersion: "1.2.3"\n')).toBe("1.2.3");
  });

  test("reads an unquoted appVersion", () => {
    expect(extractChartAppVersion("appVersion: 1.2.3\n")).toBe("1.2.3");
  });

  test("tolerates a CRLF line ending", () => {
    expect(extractChartAppVersion('appVersion: "1.2.3"\r\n')).toBe("1.2.3");
  });

  test("does not confuse the chart's own version field for appVersion", () => {
    expect(extractChartAppVersion('version: 0.1.0\nappVersion: "1.2.3"\n')).toBe("1.2.3");
  });

  test("throws when there is no appVersion", () => {
    expect(() => extractChartAppVersion("version: 0.1.0\n")).toThrow(/appVersion/);
  });
});

describe("extractComposeDefaultTag", () => {
  test("reads the default tag inside the ${MCPBRIDGE_VERSION:-...} expansion", () => {
    expect(extractComposeDefaultTag("image: ghcr.io/x/y:${MCPBRIDGE_VERSION:-1.2.3}\n")).toBe("1.2.3");
  });

  test("throws when there is no MCPBRIDGE_VERSION default", () => {
    expect(() => extractComposeDefaultTag("image: nginx:latest\n")).toThrow(/MCPBRIDGE_VERSION/);
  });
});

describe("checkParity", () => {
  const src = (label: string, version: string): VersionSource => ({ label, path: `/${label}`, version });

  test("ok when every source agrees", () => {
    const result = checkParity([src("a", "1.0.0"), src("b", "1.0.0"), src("c", "1.0.0")]);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.0.0");
    expect(result.byVersion.size).toBe(1);
  });

  test("not ok when a source diverges, grouping the sources by version", () => {
    const result = checkParity([src("a", "1.0.0"), src("b", "1.0.0"), src("c", "1.1.0")]);
    expect(result.ok).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.byVersion.size).toBe(2);
    expect(result.byVersion.get("1.0.0")?.map((s) => s.label)).toEqual(["a", "b"]);
    expect(result.byVersion.get("1.1.0")?.map((s) => s.label)).toEqual(["c"]);
  });

  test("ok on a single source (or none)", () => {
    expect(checkParity([src("a", "9.9.9")]).ok).toBe(true);
    expect(checkParity([]).ok).toBe(true);
  });
});

describe("readVersionSources (real tree — read-only)", () => {
  test("reads all five tracked sources", () => {
    const sources = readVersionSources();
    expect(sources.map((s) => s.label)).toEqual([
      "root package.json",
      "admin-ui/package.json",
      "docs/package.json",
      "helm Chart.yaml [appVersion]",
      "docker-compose.yml [default image tag]",
    ]);
  });

  test("the current tree is in parity", () => {
    expect(checkParity(readVersionSources()).ok).toBe(true);
  });
});
