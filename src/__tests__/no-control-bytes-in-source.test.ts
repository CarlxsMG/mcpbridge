/**
 * No source file may contain a literal control byte.
 *
 * This has now bitten three times, each time invisibly:
 *   - `response-cache.ts` picked up six literal NUL bytes and git began
 *     treating the file as binary, so its diffs stopped being reviewable;
 *   - an edit meant to write the ESCAPE `\x00` into a regex wrote the BYTE
 *     instead, with the same result;
 *   - `config-io.ts`'s schedule key was authored with spaces and shipped with
 *     four NUL separators, which nothing noticed because the file still
 *     compiled, still passed every test, and git's binary heuristic only reads
 *     the first 8 KB.
 *
 * A control byte in source is never intentional here. When one is genuinely
 * needed at runtime, write the escape (`"\u0000"`, `"\t"`) — that is source
 * text, and it survives this check.
 *
 * TAB and the two newline bytes are excluded: tabs appear legitimately inside
 * template literals and fixtures, and line endings are line endings.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The hand-authored trees, named explicitly rather than walking the repo and
 * excluding things. A denylist would have to keep pace with every build cache
 * and vendored artefact that appears (docs/.vitepress/cache alone ships
 * minified deps full of control bytes), and missing one turns this into a test
 * that fails for reasons no reviewer can act on.
 */
const SOURCE_ROOTS = ["src", "admin-ui/src", "admin-ui/scripts", "scripts", "e2e", "helm", "monitoring"];

/** Still needed inside those trees: generated output and dependency caches. */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-demo", "coverage", "test-results"]);

/** Extensions that are hand-authored text this rule applies to. */
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|vue|json|yaml|yml|md|css|html)$/;

/** Generated files are their generator's problem, not a review surface. */
const GENERATED = /\.generated\.(ts|json)$|bun\.lock$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry) && !GENERATED.test(entry)) {
      yield full;
    }
  }
}

describe("source hygiene", () => {
  test("no source file contains a literal control byte", () => {
    const offenders: string[] = [];
    const files = SOURCE_ROOTS.flatMap((r) => [...walk(join(ROOT, r))]);
    // A floor, so a broken SOURCE_ROOTS entry fails loudly rather than silently
    // scanning nothing and passing.
    expect(files.length).toBeGreaterThan(400);

    for (const file of files) {
      const buf = readFileSync(file);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]!;
        // C0 controls except TAB (0x09), LF (0x0A) and CR (0x0D), plus DEL.
        const isControl = (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f;
        if (isControl) {
          const line = buf.subarray(0, i).toString("utf8").split("\n").length;
          offenders.push(`${relative(ROOT, file)}:${line} — byte 0x${b.toString(16).padStart(2, "0")}`);
          break; // one report per file is enough to act on
        }
      }
    }

    expect(
      offenders,
      `Literal control bytes in source (write the escape instead, e.g. "\\u0000"):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
