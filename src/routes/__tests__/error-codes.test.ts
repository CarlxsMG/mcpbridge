// ─────────────────────────────────────────────────────────────────────────────
// Error-code catalog gate.
//
// `sendError`/`notFound`/`forbidden` take `ErrorCode`, so the COMPILER already
// covers every code that leaves through a helper. This file covers the three
// things the compiler cannot see:
//
//   1. Hand-built envelopes. A handful of paths write `res.json({ error: { code
//      … } })` directly rather than going through the helpers — the rate
//      limiter, the JSON-depth guard, the MCP transports, the Express error
//      handler, and the mutation-result unions that carry a code as data. A
//      `code: "…"` literal there is just a string to tsc.
//   2. Dead catalog entries. A code deleted from the source but left in the
//      catalog goes on being documented and translated forever.
//   3. Missing UI translations. `admin-ui` resolves `errors.api.<CODE>` to show
//      a failure in the operator's own language (falling back to the server's
//      English message). A code with no key is silently English-only, which is
//      exactly the state this catalog was introduced to end.
//
// (1) and (3) are the ones that bite: both fail open — the wrong code or the
// missing translation still renders *something*, so nothing looks broken.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES, ERROR_CODE_LIST, isErrorCode } from "../error-codes.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SRC = join(ROOT, "src");

/** Every non-test .ts file under src/ — the code that actually runs in production. */
function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      productionSources(p, out);
    } else if (p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

const sources = productionSources(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("error-code catalog", () => {
  test("every code literal in an error envelope is catalogued", () => {
    // `code: "FOO"` is the shape every hand-built envelope and every
    // mutation-result union member uses. Deliberately narrow: matching bare
    // SCREAMING_CASE strings anywhere would sweep up enum values, header names
    // and SQL keywords, and a noisy gate is one people learn to ignore.
    const codeLiteralRe = /\bcode: "([A-Z][A-Z0-9_]{2,})"/g;
    const uncatalogued: string[] = [];
    for (const { path, text } of sources) {
      if (path.endsWith(join("routes", "error-codes.ts"))) continue;
      for (const m of text.matchAll(codeLiteralRe)) {
        const code = m[1] as string;
        if (!isErrorCode(code)) uncatalogued.push(`${code} (${path.slice(ROOT.length + 1)})`);
      }
    }
    expect(uncatalogued).toEqual([]);
  });

  test("every catalogued code is actually emitted somewhere", () => {
    const allText = sources.map((s) => s.text).join("\n");
    const dead = ERROR_CODE_LIST.filter((code) => !allText.includes(`"${code}"`));
    expect(dead).toEqual([]);
  });

  test("every code has a non-empty description in both languages", () => {
    const incomplete = ERROR_CODE_LIST.filter((code) => {
      const entry = ERROR_CODES[code];
      return entry.en.trim().length === 0 || entry.es.trim().length === 0;
    });
    expect(incomplete).toEqual([]);
  });

  test("the Spanish description is actually translated, not a copy of the English", () => {
    // Same reasoning as admin-ui's i18n value-equality check: a description
    // pasted across without translating passes every other assertion here.
    const untranslated = ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].en === ERROR_CODES[code].es);
    expect(untranslated).toEqual([]);
  });

  const localeApiErrors = (file: string): Record<string, string> => {
    const bundle = JSON.parse(readFileSync(join(ROOT, "admin-ui", "src", "locales", file), "utf8")) as {
      errors?: { api?: Record<string, string> };
    };
    return bundle.errors?.api ?? {};
  };

  test("admin-ui can translate every non-verbatim code, in both bundles", () => {
    const translatable = ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].verbatim !== true);
    const en = localeApiErrors("en.json");
    const es = localeApiErrors("es.json");
    expect(translatable.filter((code) => !en[code])).toEqual([]);
    expect(translatable.filter((code) => !es[code])).toEqual([]);
  });

  test("verbatim codes have NO translation, so the server's specifics survive", () => {
    // The failure this prevents: someone adds `errors.api.VALIDATION_ERROR` in
    // good faith, and every field-level validation message in the product
    // silently becomes "The request failed validation." — strictly less useful
    // than the English sentence it replaced, on 91 call sites at once.
    const verbatim = ERROR_CODE_LIST.filter((code) => ERROR_CODES[code].verbatim === true);
    const en = localeApiErrors("en.json");
    const es = localeApiErrors("es.json");
    expect(verbatim.filter((code) => en[code] !== undefined)).toEqual([]);
    expect(verbatim.filter((code) => es[code] !== undefined)).toEqual([]);
  });

  test("no translation exists for a code the gateway can no longer emit", () => {
    // Dead weight the admin-ui orphan check cannot see: these keys are all
    // reached through one dynamic `errors.api.${code}` lookup, so it only ever
    // proves the *prefix* is referenced.
    const catalogued = new Set<string>(ERROR_CODE_LIST);
    expect(Object.keys(localeApiErrors("en.json")).filter((code) => !catalogued.has(code))).toEqual([]);
    expect(Object.keys(localeApiErrors("es.json")).filter((code) => !catalogued.has(code))).toEqual([]);
  });
});
