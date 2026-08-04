// Count-bearing messages must use vue-i18n pluralization, not a hand-written "(s)".
//
// The catalogs used to spell counts as "{count} server(s) on this page", which reads
// as filler in English and is worse in Spanish, where agreement spreads across the
// sentence: "{count} MCP API key(s) activa(s)". The mechanism to do it properly was
// already in the repo and working — command_palette.tools_count has been a real
// 3-form plural all along — it was just used exactly once.
//
// Two invariants, so the old shape cannot creep back and a new plural cannot be
// half-converted (message split, call site still passing no index):
//   1. No catalog value contains a "(s)"-style suffix.
//   2. Every plural message actually selects a different branch on 1 vs 2, in both
//      locales — which is what proves the call sites' third argument is wired up.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const i18n = (
  globalThis as unknown as {
    __testI18n: {
      global: {
        t(k: string, named: Record<string, unknown>, plural: number): string;
        locale: { value: string };
      };
    };
  }
).__testI18n;

// Read the catalogs off disk rather than importing them: @intlify/unplugin-vue-i18n
// precompiles locale JSON into message ASTs (and intercepts `?raw` too), so an
// import gives objects where this test needs the literal source strings.
const LOCALES = ["en", "es"] as const;
const catalog = (locale: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), "src", "locales", `${locale}.json`), "utf8"));

/** Walks a precompiled-or-plain catalog and yields [dottedKey, rawValue] for string leaves. */
function leaves(node: unknown, path: string[] = [], out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path.join("."), node]);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) leaves(v, [...path, k], out);
  }
  return out;
}

describe("pluralization", () => {
  it("has no hand-written '(s)' plurals left in either catalog", () => {
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of leaves(catalog(locale))) {
        if (/\((?:s|es|n|a)\)/.test(value)) offenders.push(`[${locale}] ${key}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("selects a different branch for 1 and 2 in every locale", () => {
    const broken: string[] = [];
    const original = i18n.global.locale.value;
    try {
      for (const locale of LOCALES) {
        // `t()` resolves against the ACTIVE locale, so this has to switch — iterating
        // the catalogs alone would just check English twice, and Spanish agreement
        // ("1 key activa" vs "{count} keys activas") is the harder half.
        i18n.global.locale.value = locale;
        for (const [key, value] of leaves(catalog(locale))) {
          if (!value.includes(" | ")) continue;
          const named = { count: 2, applied: 2, name: "x", bundle: "b", strategy: "s", weight: 1, enabled: "on" };
          const one = i18n.global.t(key, { ...named, count: 1, applied: 1 }, 1);
          const two = i18n.global.t(key, named, 2);
          if (one === two) broken.push(`[${locale}] ${key} renders identically for 1 and 2`);
          if (one.includes("|") || two.includes("|")) broken.push(`[${locale}] ${key} leaked the '|' separator`);
        }
      }
    } finally {
      i18n.global.locale.value = original;
    }
    expect(broken).toEqual([]);
  });
});
