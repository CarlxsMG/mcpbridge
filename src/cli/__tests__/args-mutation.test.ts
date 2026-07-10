import { describe, test, expect } from "bun:test";
import { parseFlags } from "../args.js";

/**
 * Mutation-testing backstop for src/cli/args.ts's parseFlags().
 *
 * src/cli/__tests__/cli.test.ts (existing, untouched) already covers:
 *   - `--flag value`, `--flag=value`, and bare boolean `--flag` forms
 *   - a flag immediately followed by another `--flag` (forced boolean, not
 *     consuming the next token as a value)
 *   - positionals interleaved with flags
 *
 * This file gap-fills the cases that don't naturally arise from those
 * fixtures: a flag as the very last argv element (no lookahead token at
 * all, as opposed to a lookahead token that starts with "--"), the "="
 * split's exact boundaries (empty key, empty value, multiple "="), a
 * single-dash lookahead token (must NOT be treated as a flag terminator),
 * an all-positional argv, and a genuinely empty argv.
 */
describe("parseFlags — gap-fill", () => {
  test("empty argv returns empty positionals and flags", () => {
    expect(parseFlags([])).toEqual({ positionals: [], flags: {} });
  });

  test("all-positional argv (no flags at all)", () => {
    const { positionals, flags } = parseFlags(["foo", "bar", "baz"]);
    expect(positionals).toEqual(["foo", "bar", "baz"]);
    expect(flags).toEqual({});
  });

  test("a flag as the very last argv element (no lookahead token at all) becomes boolean true", () => {
    // Distinct from "a flag immediately followed by another --flag" (already
    // covered elsewhere): here argv[i + 1] is `undefined`, not a "--..."
    // string, so this exercises the `argv[i + 1] !== undefined` clause
    // itself rather than the `!argv[i + 1].startsWith("--")` clause.
    const { positionals, flags } = parseFlags(["--verbose"]);
    expect(positionals).toEqual([]);
    expect(flags).toEqual({ verbose: true });
  });

  test("a flag followed by nothing, after a preceding positional, is still boolean true", () => {
    const { positionals, flags } = parseFlags(["deploy", "--force"]);
    expect(positionals).toEqual(["deploy"]);
    expect(flags).toEqual({ force: true });
  });

  test("a single-dash lookahead token IS consumed as the flag's value (only '--' terminates)", () => {
    const { positionals, flags } = parseFlags(["--tag", "-1"]);
    expect(positionals).toEqual([]);
    expect(flags).toEqual({ tag: "-1" });
  });

  test("'--name=' with an empty value after '=' yields an empty string, not boolean true", () => {
    const { flags } = parseFlags(["--name="]);
    expect(flags).toEqual({ name: "" });
    expect(flags.name).not.toBe(true);
  });

  test("'--=value' (equals at the earliest possible position) yields an empty-string key", () => {
    const { flags } = parseFlags(["--=value"]);
    expect(flags).toEqual({ "": "value" });
  });

  test("only the first '=' splits key from value; later '=' stay in the value", () => {
    const { flags } = parseFlags(["--range=1=2"]);
    expect(flags.range).toBe("1=2");
  });

  test("three flags in a row: value, boolean (next starts with --), then boolean (end of argv)", () => {
    // Also proves the index bump from consuming a value (`argv[++i]`)
    // doesn't skip or duplicate a subsequent flag.
    const { positionals, flags } = parseFlags(["--file", "x.yaml", "--dry-run", "--yes"]);
    expect(positionals).toEqual([]);
    expect(flags).toEqual({ file: "x.yaml", "dry-run": true, yes: true });
  });

  test("a consumed value is not re-processed as a positional", () => {
    const { positionals, flags } = parseFlags(["--out", "report.json", "trailing"]);
    expect(positionals).toEqual(["trailing"]);
    expect(flags).toEqual({ out: "report.json" });
  });
});
