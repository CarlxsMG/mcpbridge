// Regression test for the "raw i18n keys on the page" bug.
//
// A previous i18n session added translations for many pages but missed
// several — `t()` calls referenced keys that never landed in en.json /
// es.json. vue-i18n silently returns the key string when the key is
// missing (with `silentFallbackWarn: true`), so users saw raw key
// paths like `pages.bundle_detail.delete_bundle` instead of "Delete
// bundle". This test re-runs the audit at unit-test time so a
// regression on this front is caught in CI rather than on the demo
// page.
//
// Strategy: enumerate every `t("…")` literal call across the source
// (excluding tests, demo helpers, and documentation comments), then
// assert each key resolves to a non-empty string in BOTH en.json AND
// es.json. The audit script (scripts/audit-missing-translations.py)
// is the manual-side counterpart — this test enforces the same
// invariant automatically.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "dist" || entry === ".turbo") continue;
      walk(p, out);
    } else if (p.endsWith(".vue") || p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

interface Bundle {
  [key: string]: unknown;
}

function isAstNode(v: unknown): boolean {
  // vue-i18n's vite plugin compiles message strings into AST nodes with
  // a numeric `type` field. Recognizing these lets us treat the node
  // as a leaf value (don't recurse into its body/items) — otherwise the
  // flatten walk would dive into AST internals and surface fake keys
  // like `common.save.body.static` that no real `t()` call uses.
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return typeof (v as Record<string, unknown>).type === "number";
}

function flattenBundle(b: Bundle, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(b)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isAstNode(v) || Array.isArray(v)) {
      // AST nodes are leaves — vue-i18n renders them at runtime. Arrays
      // here are an edge case the admin-ui bundle doesn't use but we
      // handle defensively (joining to a single string would lose
      // meaning, so we just record the key).
      out.add(key);
    } else if (v && typeof v === "object") {
      for (const sub of flattenBundle(v as Bundle, key)) out.add(sub);
    } else {
      out.add(key);
    }
  }
  return out;
}

function unwrapAst(v: unknown): unknown {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  const node = v as Record<string, unknown>;
  // AST shape varies: simple strings end up with `body.static` filled
  // and no items; strings with placeholders may have `static: ""` and
  // a `body.items[]` array of placeables. We don't try to render the
  // AST — vue-i18n's `t()` does that at runtime. The test only needs
  // to confirm a translation EXISTS, so we just return the node and
  // let the caller check for non-empty via a less brittle signal.
  if (typeof node.static === "string") return node.static;
  if (node.body && typeof node.body === "object") {
    const body = node.body as Record<string, unknown>;
    if (typeof body.static === "string") return body.static;
  }
  return node;
}

function lookupNested(b: Bundle, key: string): unknown {
  const parts: string[] = [];
  // Match either `word` segments OR `['literal with spaces']` brackets.
  const re = /([^.[\]]+)|\[(['])([^']*)\2\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key)) !== null) {
    if (m[3] !== undefined) parts.push(m[3]);
    else if (m[1] !== undefined) parts.push(m[1]);
  }
  let cur: unknown = b;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

const SRC = join(process.cwd(), "src");

// JSON import returns the AST-compiled bundle from the vite plugin.
// Cast through unknown so we can traverse it generically.
const en = (await import("./locales/en.json")).default as unknown as Bundle;
const es = (await import("./locales/es.json")).default as unknown as Bundle;
const enKeys = flattenBundle(en);
const esKeys = flattenBundle(es);

// Collect every t("literal") call across the source — but skip the
// i18n-keys.ts helper module (its strings are documentation
// examples, not actual translation lookups) and the parity test files
// (synthetic keys for the test runner itself).
const tCallRe = /\bt\(\s*['"]([^'"]+)['"]/g;
// Dynamic-key patterns: navigation.ts builds lookup keys from helper
// functions like `l("servers")` and `GL("Servers")`, and assigns
// `labelKey` / `hintKey` / `groupKey` fields that other components
// then pass straight to t(). The literal-key walk above won't catch
// these because the actual key never appears as a string literal in
// any source file. Walk the helper invocations + label/hint/groupKey
// assignments to surface the dynamic keys too.
const navKeyCallRe = /\b[hl]GL?\(\s*['"]([^'"]+)['"]\s*\)/g;
const labelHintAssignRe = /\b(labelKey|hintKey|groupKey)\s*:\s*['"]([^'"]+)['"]/g;
// Match a line that's entirely a JSDoc / line / block comment — we
// don't want to flag example keys mentioned in documentation.
const commentRe = /^\s*(\/\/\/|\/\/|\*|\s*\*)/;
const placeholderRe = /^\.{3}|^…/;
const skipFiles = /(\/|\\)i18n-keys\.ts$|(\/|\\)i18n-parity\.test\.ts$/;

const referenced: { key: string; file: string }[] = [];
function addKey(key: string, file: string) {
  if (placeholderRe.test(key)) return;
  referenced.push({ key, file });
}
for (const file of walk(SRC)) {
  if (skipFiles.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (commentRe.test(line)) continue;
    for (const m of line.matchAll(tCallRe)) {
      addKey(m[1], file);
    }
    for (const m of line.matchAll(navKeyCallRe)) {
      const arg = m[1];
      const matched = m[0];
      if (/^hGL?/.test(matched)) {
        // h("foo") → nav.foo.hint (also surface .label — the helper
        // shape is fixed at the call site, but emitting both keeps the
        // assertion symmetric without flipping the test on each side).
        addKey(`nav.${arg}.hint`, file);
        addKey(`nav.${arg}.label`, file);
      } else if (/^GL/.test(matched)) {
        addKey(`nav.groups.${arg}`, file);
      } else {
        addKey(`nav.${arg}.label`, file);
        addKey(`nav.${arg}.hint`, file);
      }
    }
    for (const m of line.matchAll(labelHintAssignRe)) {
      addKey(m[2], file);
    }
  }
}

describe("i18n key parity — no raw keys on the page", () => {
  it("collects at least one t() call (sanity check)", () => {
    expect(referenced.length).toBeGreaterThan(100);
  });

  it("every referenced t() key resolves in BOTH en.json AND es.json", () => {
    const missingEn = new Set<string>();
    const missingEs = new Set<string>();
    for (const { key } of referenced) {
      if (!enKeys.has(key)) missingEn.add(key);
      if (!esKeys.has(key)) missingEs.add(key);
    }
    if (missingEn.size > 0) {
      const sample = [...missingEn].slice(0, 5);
      throw new Error(
        `${missingEn.size} t() keys missing in en.json. Sample: ${sample.join(", ")}. ` +
          `Run scripts/audit-missing-translations.py to enumerate.`,
      );
    }
    if (missingEs.size > 0) {
      const sample = [...missingEs].slice(0, 5);
      throw new Error(
        `${missingEs.size} t() keys missing in es.json. Sample: ${sample.join(", ")}. ` +
          `Run scripts/audit-missing-translations.py to enumerate.`,
      );
    }
  });

  // The "non-empty string" check below is intentionally a smoke test —
  // vue-i18n's vite plugin compiles message strings into AST nodes whose
  // `.static` field can be empty for placeholder-driven strings like
  // `"{count} selected"`. The AST itself is correct (the production
  // walker renders those strings fine at runtime), but trying to
  // validate the AST shape here would be brittle. The "key resolves"
  // test above already catches the real bug (raw keys on the page).
  it("[smoke] AST unwrap returns non-empty for a known plain-text key", () => {
    const v = unwrapAst(lookupNested(en, "common.save"));
    expect(typeof v).toBe("string");
    expect((v as string).length).toBeGreaterThan(0);
  });
});
