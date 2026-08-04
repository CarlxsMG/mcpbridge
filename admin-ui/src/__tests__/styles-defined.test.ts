// Every static class in a component's template must actually be styled somewhere
// that REACHES that component.
//
// Why this exists: commit f74e988 was an i18n pass that, as collateral, deleted all
// but one rule from ServersPage.vue's `<style scoped>` block. The tag browser, the
// bulk-action bar, the filter labels, the truncated URL column and the kind badge's
// spacing silently lost their styling on the app's landing page and stayed that way
// for a month. Nothing caught it: every test asserts rendered TEXT, and text is
// exactly what survives a missing stylesheet.
//
// The subtle half is scoping. `.cell-truncate` and `.inline-check` both *looked*
// defined — grep found them — but their only definitions lived in a DIFFERENT
// component's `<style scoped>` block, which never crosses a component boundary. So
// a naive "is this class mentioned in any .vue file" check reports green on exactly
// the bug it is supposed to catch. Hence: a class counts as defined for a component
// only if it comes from that component's own <style>, from a global (non-scoped)
// stylesheet, or from an explicit `:slotted()` / `:deep()` selector — the two
// constructs that are *designed* to cross the boundary (FormPage.vue's
// `:slotted(.form-card)` is the load-bearing example).
//
// Scope: static `class="..."` attributes only. Dynamic `:class` bindings are out of
// reach of a static check and are deliberately not covered.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// `join(process.cwd(), "src")`, not import.meta.url — Vitest does not expose this
// file's import.meta.url as a real file:// URL. Same idiom as i18n-parity.test.ts;
// demo-contract.test.ts documents the same gotcha.
const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every class name appearing in a selector position within a chunk of CSS. */
function selectorClasses(css: string, into: Set<string>): void {
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) into.add(m[1]);
}

const STYLE_BLOCK = /<style([^>]*)>([\s\S]*?)<\/style>/g;
const CROSS_BOUNDARY = /:(?:slotted|deep)\(([^)]*)\)/g;

const files = walk(SRC);
const vueFiles = files.filter((f) => f.endsWith(".vue"));
const cssFiles = files.filter((f) => f.endsWith(".css"));

// Classes reachable from anywhere: global stylesheets, non-scoped <style> blocks,
// and anything explicitly published across a component boundary.
const globallyReachable = new Set<string>();
for (const f of cssFiles) selectorClasses(readFileSync(f, "utf8"), globallyReachable);
for (const f of vueFiles) {
  const src = readFileSync(f, "utf8");
  for (const [, attrs, body] of src.matchAll(STYLE_BLOCK)) {
    if (!/\bscoped\b/.test(attrs)) selectorClasses(body, globallyReachable);
    for (const [, inner] of body.matchAll(CROSS_BOUNDARY)) selectorClasses(inner, globallyReachable);
  }
}

describe("component styles", () => {
  it("defines every static template class in a stylesheet that reaches the component", () => {
    const undefinedClasses: string[] = [];

    for (const file of vueFiles) {
      const src = readFileSync(file, "utf8");
      const template = src.match(/<template>([\s\S]*)<\/template>/);
      if (!template) continue;

      const own = new Set<string>();
      for (const [, , body] of src.matchAll(STYLE_BLOCK)) selectorClasses(body, own);

      const reported = new Set<string>();
      for (const [, value] of template[1].matchAll(/\sclass="([^"{}]*)"/g)) {
        for (const cls of value.split(/\s+/).filter(Boolean)) {
          if (own.has(cls) || globallyReachable.has(cls) || reported.has(cls)) continue;
          reported.add(cls);
          undefinedClasses.push(`${file.slice(SRC.length).replace(/\\/g, "/")} → .${cls}`);
        }
      }
    }

    expect(undefinedClasses).toEqual([]);
  });
});
