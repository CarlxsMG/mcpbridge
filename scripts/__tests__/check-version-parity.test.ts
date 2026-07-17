import { describe, expect, test } from "bun:test";

import {
  checkParity,
  extractBunTypesVersion,
  extractBunVersionFile,
  extractChartAppVersion,
  extractComposeDefaultTag,
  extractDockerfileBunVersion,
  extractPackageJsonVersion,
  extractPackageManagerBunVersion,
  readBunVersionSources,
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

describe("extractBunVersionFile", () => {
  test("reads the trimmed file content", () => {
    expect(extractBunVersionFile("1.3.11\n")).toBe("1.3.11");
  });

  test("tolerates surrounding whitespace and a CRLF line ending", () => {
    expect(extractBunVersionFile("  1.3.11  \r\n")).toBe("1.3.11");
  });

  test("throws on an empty file", () => {
    expect(() => extractBunVersionFile("   \n")).toThrow(/empty/);
  });
});

describe("extractPackageManagerBunVersion", () => {
  test("reads a bun@<version> spec", () => {
    expect(extractPackageManagerBunVersion('{ "packageManager": "bun@1.3.11" }', "x")).toBe("1.3.11");
  });

  test("tolerates a Corepack integrity suffix", () => {
    expect(extractPackageManagerBunVersion('{ "packageManager": "bun@1.3.11+sha256.abc" }', "x")).toBe("1.3.11");
  });

  test("throws on invalid JSON", () => {
    expect(() => extractPackageManagerBunVersion("{ not json", "x")).toThrow(/valid JSON/);
  });

  test("throws when there is no packageManager field", () => {
    expect(() => extractPackageManagerBunVersion('{ "name": "x" }', "x")).toThrow(/packageManager/);
  });

  test("throws when packageManager is not a string", () => {
    expect(() => extractPackageManagerBunVersion('{ "packageManager": 123 }', "x")).toThrow(/string/);
  });

  test("throws when packageManager does not name bun", () => {
    expect(() => extractPackageManagerBunVersion('{ "packageManager": "pnpm@9.0.0" }', "x")).toThrow(/bun@/);
  });
});

describe("extractBunTypesVersion", () => {
  test("reads bun-types from devDependencies", () => {
    expect(extractBunTypesVersion('{ "devDependencies": { "bun-types": "1.3.11" } }', "x")).toBe("1.3.11");
  });

  test("falls back to dependencies", () => {
    expect(extractBunTypesVersion('{ "dependencies": { "bun-types": "1.3.11" } }', "x")).toBe("1.3.11");
  });

  test("returns the raw spec so a range prefix trips the parity gate", () => {
    expect(extractBunTypesVersion('{ "devDependencies": { "bun-types": "^1.3.11" } }', "x")).toBe("^1.3.11");
  });

  test("throws on invalid JSON", () => {
    expect(() => extractBunTypesVersion("{ not json", "x")).toThrow(/valid JSON/);
  });

  test("throws when there is no bun-types dependency", () => {
    expect(() => extractBunTypesVersion('{ "devDependencies": { "typescript": "5" } }', "x")).toThrow(/bun-types/);
  });

  test("throws when bun-types is not a string", () => {
    expect(() => extractBunTypesVersion('{ "devDependencies": { "bun-types": 1 } }', "x")).toThrow(/string/);
  });
});

describe("extractDockerfileBunVersion", () => {
  test("reads the ARG BUN_VERSION default", () => {
    expect(extractDockerfileBunVersion("ARG BUN_VERSION=1.3.11\nFROM oven/bun:${BUN_VERSION}-alpine\n")).toBe("1.3.11");
  });

  test("tolerates a CRLF line ending", () => {
    expect(extractDockerfileBunVersion("ARG BUN_VERSION=1.3.11\r\n")).toBe("1.3.11");
  });

  test("throws when there is no ARG BUN_VERSION", () => {
    expect(() => extractDockerfileBunVersion("FROM oven/bun:alpine\n")).toThrow(/BUN_VERSION/);
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

describe("readBunVersionSources (real tree — read-only)", () => {
  test("reads all six tracked sources", () => {
    const sources = readBunVersionSources();
    expect(sources.map((s) => s.label)).toEqual([
      ".bun-version",
      "root package.json [packageManager]",
      "admin-ui/package.json [packageManager]",
      "docs/package.json [packageManager]",
      "root package.json [bun-types]",
      "Dockerfile [ARG BUN_VERSION]",
    ]);
  });

  test("the current tree's Bun runtime version is in parity", () => {
    expect(checkParity(readBunVersionSources()).ok).toBe(true);
  });
});
