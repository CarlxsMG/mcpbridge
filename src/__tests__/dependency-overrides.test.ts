/**
 * Every `overrides` entry in package.json is documented, and shaped safely.
 *
 * An override is a permanent, silent edit to the dependency graph that nothing
 * else in this repo ever revisits: `bun audit` does not know why one exists,
 * and Dependabot cannot see them at all. Left unwatched they accumulate — this
 * block went from one entry to four inside three days — and a stale one is not
 * harmless, because it keeps forcing a version on consumers that have since
 * moved past it.
 *
 * Two properties are worth failing a build over:
 *   1. Every override has a written reason, so "can this go yet?" is answerable
 *      by reading rather than by archaeology through commit messages.
 *   2. Every key is scoped to a major. A bare key forces EVERY copy in the tree
 *      to the new version regardless of what each consumer declared — that is
 *      not hypothetical here: `"brace-expansion": "^5.0.8"` once dragged the
 *      `^2.0.2` copies under minimatch@9 up to 5.x, where the dropped default
 *      export killed it with `brace_expansion_1.default is not a function`.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const packageOverrides: Record<string, string> =
  (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).overrides as Record<string, string>) ?? {};

interface OverrideDoc {
  advisories: string[];
  reason: string;
  dropWhen: string;
}
const documented: Record<string, OverrideDoc> = JSON.parse(
  readFileSync(join(ROOT, "dependency-overrides.json"), "utf8"),
).overrides;

/** `pkg@5` or `@scope/pkg@5` — the trailing `@<major>` is the part that matters. */
const MAJOR_SCOPED = /^(?:@[^/@]+\/)?[^@]+@\d+$/;

describe("package.json overrides", () => {
  test("every override is documented", () => {
    const undocumented = Object.keys(packageOverrides).filter((k) => !(k in documented));
    expect(undocumented, `Add an entry to dependency-overrides.json for: ${undocumented.join(", ")}`).toEqual([]);
  });

  test("no documentation outlives its override", () => {
    // The other direction. A doc entry for an override that has been removed is
    // a claim about the tree that is no longer true, and reading it would lead
    // someone to believe a version is still being forced when it is not.
    const orphaned = Object.keys(documented).filter((k) => !(k in packageOverrides));
    expect(orphaned, `Remove from dependency-overrides.json: ${orphaned.join(", ")}`).toEqual([]);
  });

  test("every override key is scoped to a major version", () => {
    const bare = Object.keys(packageOverrides).filter((k) => !MAJOR_SCOPED.test(k));
    expect(
      bare,
      `A bare key forces every copy in the tree, not just the vulnerable line. Use "pkg@<major>": ${bare.join(", ")}`,
    ).toEqual([]);
  });

  test("the override version stays inside the major its key names", () => {
    // `"hono@4": "^5.0.0"` would silently be a major bump wearing a scoped key
    // — the shape looks careful and the effect is the thing the scoping exists
    // to prevent.
    const mismatched = Object.entries(packageOverrides).filter(([key, range]) => {
      const keyMajor = key.slice(key.lastIndexOf("@") + 1);
      const rangeMajor = /(\d+)\./.exec(range)?.[1];
      return rangeMajor !== undefined && rangeMajor !== keyMajor;
    });
    expect(
      mismatched.map(([k, v]) => `${k} -> ${v}`),
      "Override range leaves the major its key scopes it to",
    ).toEqual([]);
  });

  test("each documented override names at least one advisory, in GHSA form", () => {
    // The advisory id is what makes "is this still needed?" a question with an
    // answer. A prose-only entry ages into folklore.
    for (const [key, doc] of Object.entries(documented)) {
      expect(doc.advisories.length, `${key} names no advisory`).toBeGreaterThan(0);
      for (const id of doc.advisories) {
        expect(id, `${key}: ${id} is not a GHSA id`).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      }
    }
  });

  test("each documented override says what would let it be removed", () => {
    for (const [key, doc] of Object.entries(documented)) {
      expect(doc.reason.length, `${key} has no reason`).toBeGreaterThan(20);
      expect(doc.dropWhen.length, `${key} has no dropWhen`).toBeGreaterThan(20);
    }
  });

  test("the manifest actually describes something — an empty block passes everything above vacuously", () => {
    expect(Object.keys(documented).length).toBeGreaterThan(0);
  });

  test("every override is actually in effect in the lockfile", () => {
    // The one that catches a real, already-made mistake. Adding an override to
    // package.json does NOT move an already-resolved package: bun records the
    // override but leaves the pinned entry alone, so `rm -rf node_modules &&
    // bun install` reports success while still installing the vulnerable copy.
    // That happened here, and the only tell was reading the resolved version by
    // hand. An override that has not landed is worse than none — it reads as
    // protection in review and provides none.
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    const notInEffect: string[] = [];

    for (const [key, range] of Object.entries(packageOverrides)) {
      const name = key.slice(0, key.lastIndexOf("@"));
      const entry = new RegExp(
        `"${name.replace(/[/@]/g, "\\$&")}": \\["${name.replace(/[/@]/g, "\\$&")}@([^"]+)"`,
      ).exec(lock);
      if (!entry) continue; // no longer in the tree at all — the orphan case above covers that
      const resolved = entry[1]!;
      if (!atOrAbove(resolved, range)) notInEffect.push(`${key}: lockfile has ${resolved}, override wants ${range}`);
    }

    expect(
      notInEffect,
      `Override declared but not resolved. Hand-edit the resolved bun.lock entry — see CLAUDE.md:\n${notInEffect.join("\n")}`,
    ).toEqual([]);
  });
});

/** True when `version` is at or above the floor of a `^x.y.z` range. */
function atOrAbove(version: string, range: string): boolean {
  const floor = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  const got = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!floor || !got) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(got[i]);
    const b = Number(floor[i]);
    if (a !== b) return a > b;
  }
  return true;
}
