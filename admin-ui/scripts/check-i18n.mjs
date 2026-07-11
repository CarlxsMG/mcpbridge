#!/usr/bin/env node
// Validates the two admin-ui locale bundles two ways:
//
//   1. Parity — every key present in en.json is also present in es.json (and
//      vice-versa for sanity), so a missing translation gets caught at CI
//      time, not at runtime.
//
//   2. Orphans — every key in en.json/es.json is actually referenced
//      somewhere under admin-ui/src/**. Keys can drift into existence
//      (renamed pages, abandoned features, copy-pasted sections) and, since
//      they're always added/removed from both locale files together, the
//      parity check alone can never catch them — they stay "in parity"
//      forever while being dead weight to translate and maintain.
//
// Future languages: extend this script to load each locale under
// `src/locales/*.json` and assert parity + orphan-freedom against en.json.
//
// Usage: bun run scripts/check-i18n.mjs   (also wrapped as `lint:i18n`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "..", "src", "locales");
const SRC_DIR = path.resolve(__dirname, "..", "src");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function* walk(obj, prefix = "") {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    yield prefix;
    return;
  }
  for (const key of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    yield* walk(obj[key], next);
  }
}

function diff(enKeys, esKeys) {
  const esSet = new Set(esKeys);
  return enKeys.filter((k) => !esSet.has(k));
}

// ─────────────────────────────────────────────────────────────────────────
// Orphan detection
//
// Most keys are found via a literal `t("some.key")` / `tk('some.key')` call,
// but this codebase has a handful of deliberate dynamic-key-construction
// patterns that never write the resolved key as a literal string anywhere
// (or write it in a shape a naive grep wouldn't match). Each one gets its
// own targeted extractor below so it doesn't get misreported as dead:
//
//   - `navigation.ts`'s `l("name")` / `h("name")` / `GL("Group")` helpers,
//     which build `nav.<name>.label` / `.hint` / `nav.groups.<Group>` at
//     runtime — the composed key is never a literal anywhere.
//   - `labelKey:` / `hintKey:` / `groupKey:` object fields whose value is a
//     literal key string, consumed later as `t(meta.labelKey)` (e.g.
//     StatusBadge.vue's STATUS_META, OverviewPage.vue's WINDOW_VALUES).
//   - `demo/i18n-keys.ts`'s `demoKey` / `demoKeyByValue` / `demoDetailKey`
//     helpers, which compose `demo.fixtures.*` keys from fixture data at
//     module load (see that file's docblock for the exact namespacing
//     rules this mirrors).
//   - Template-literal keys like `` t(`pages.account.locale_${code}`) `` —
//     handled generically: any `` t(`...`) ``/`` tk(`...`) `` template is
//     turned into a regex (interpolations become a `[^.]*` wildcard) and
//     matched against candidate orphan keys before giving up on them.
//
// Anything left over gets one last chance: a plain substring search for the
// key as a quoted literal anywhere in the source (catches lookup tables like
// `widgetCatalog.ts`'s GROUP_LABELS, where the key string is a plain object
// value, not an argument to `t()`/`tk()` at the point it's written).
//
// This is deliberately biased toward false negatives (treating a key as
// "used" when in doubt) over false positives — the cost of a stray dead key
// surviving one more audit is much lower than the cost of this check
// flagging (and someone reflexively deleting) a key that's genuinely wired
// up through a pattern this script doesn't know about yet.
// ─────────────────────────────────────────────────────────────────────────

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
      walkSourceFiles(p, out);
    } else if (p.endsWith(".vue") || p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

const commentRe = /^\s*(\/\/\/|\/\/|\*|\s*\*)/;
const placeholderRe = /^\.{3}|^…/;

// t("literal") / tk('literal') — the two translation-lookup helpers used
// throughout admin-ui (`tk` is a non-reactive `useI18n`-free variant of `t`
// defined ad hoc per file/composable; see src/i18n.ts's `tk` and the several
// local `const tk = (k) => i18n.global.t(...)` re-implementations).
const tCallRe = /\b(?:t|tk)\(\s*['"]([^'"]+)['"]/g;
// The handful of call sites that skip the `tk` wrapper and cast+call
// `i18n.global.t` inline, e.g.:
//   (i18n.global.t as (k: string) => string)("errors.update_failed")
const castCallRe = /\(i18n\.global\.t\s+as\s*\([^)]*\)\s*=>\s*string\)\(\s*['"]([^'"]+)['"]/g;
// navigation.ts's key-builder helpers: l("name") -> nav.<name>.label,
// h("name") -> nav.<name>.hint, GL("Group") -> nav.groups.<Group>.
const navKeyCallRe = /\b(GL|[hl])\(\s*['"]([^'"]+)['"]\s*\)/g;
// Generic `labelKey:`/`hintKey:`/`groupKey:` field literal assignments —
// covers both navigation.ts's NavEntry objects and unrelated lookup tables
// (StatusBadge.vue's STATUS_META, OverviewPage.vue's WINDOW_VALUES, ...).
const labelHintAssignRe = /\b(labelKey|hintKey|groupKey)\s*:\s*['"]([^'"]+)['"]/g;
// demo/i18n-keys.ts helpers — matched with literal args only (that's the
// only way any fixture calls them today; see demo/fixtures/*.ts).
const demoKeyRe = /\bdemoKey\(\s*['"]([^'"]+)['"]\s*,\s*(?:['"]([^'"]+)['"]|(\d+))\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const demoKeyByValueRe =
  /\bdemoKeyByValue\(\s*['"]([^'"]+)['"]\s*,\s*['"]((?:[^'"\\]|\\.)*)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const demoDetailKeyRe =
  /\bdemoDetailKey\(\s*['"]([^'"]+)['"]\s*,\s*(?:['"]([^'"]+)['"]|(\d+))\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
// Template-literal calls: t(`...${...}...`) / tk(`...`).
const templateCallRe = /\b(?:t|tk)\(\s*`([^`]*)`/g;

// Mirrors demo/i18n-keys.ts's demoKey/demoDetailKey dot-escaping (entity IDs
// containing "." get their dots swapped for "__" so vue-i18n's dot-walker
// doesn't misparse them as nested path segments).
function demoKey(domain, entityId, field) {
  const safeId = String(entityId).replace(/\./g, "__");
  return `demo.fixtures.${domain}.${safeId}.${field}`;
}
// NOTE: the real demoKeyByValue (demo/i18n-keys.ts) emits vue-i18n
// bracket-notation for free-form values at runtime, e.g.
// `by_value['Claude Desktop']`. This comparison-only variant instead
// produces the plain dot-joined shape `walk()` yields when flattening the
// actual nested JSON object (whose key is literally "Claude Desktop" —
// brackets/quotes are a vue-i18n calling convention, not part of the JSON).
function demoKeyByValue(domain, value, field) {
  return `demo.fixtures.${domain}.by_value.${value}.${field}`;
}
function demoDetailKey(domain, recordId, detailField, field) {
  const safeId = String(recordId).replace(/\./g, "__");
  return `demo.fixtures.${domain}.${safeId}.detail.${detailField}.${field}`;
}

function collectReferences() {
  const referenced = new Set();
  const dynamicPatterns = [];

  function addKey(key) {
    if (placeholderRe.test(key)) return;
    referenced.add(key);
  }

  const files = walkSourceFiles(SRC_DIR);
  const fileTexts = files.map((f) => fs.readFileSync(f, "utf8"));

  for (const text of fileTexts) {
    for (const line of text.split("\n")) {
      if (commentRe.test(line)) continue;

      for (const m of line.matchAll(tCallRe)) addKey(m[1]);
      for (const m of line.matchAll(castCallRe)) addKey(m[1]);

      for (const m of line.matchAll(navKeyCallRe)) {
        const [fn, arg] = [m[1], m[2]];
        if (fn === "GL") addKey(`nav.groups.${arg}`);
        else if (fn === "h") addKey(`nav.${arg}.hint`);
        else if (fn === "l") addKey(`nav.${arg}.label`);
      }

      for (const m of line.matchAll(labelHintAssignRe)) addKey(m[2]);

      for (const m of line.matchAll(demoKeyRe)) {
        addKey(demoKey(m[1], m[2] !== undefined ? m[2] : m[3], m[4]));
      }
      for (const m of line.matchAll(demoKeyByValueRe)) {
        addKey(demoKeyByValue(m[1], m[2], m[3]));
      }
      for (const m of line.matchAll(demoDetailKeyRe)) {
        addKey(demoDetailKey(m[1], m[2] !== undefined ? m[2] : m[3], m[4], m[5]));
      }

      for (const m of line.matchAll(templateCallRe)) {
        // Turn `pages.account.locale_${code}` into a regex: each `${...}`
        // becomes `[^.]*` (dynamic segments never span a `.` in this
        // codebase's conventions), everything else is escaped literally.
        const escaped = m[1]
          .split(/\$\{[^}]*\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^.]*");
        dynamicPatterns.push(new RegExp(`^${escaped}$`));
      }
    }
  }

  return { referenced, dynamicPatterns, rawText: fileTexts.join("\n") };
}

function findOrphans(localeKeys, { referenced, dynamicPatterns, rawText }) {
  const orphans = [];
  for (const key of localeKeys) {
    if (referenced.has(key)) continue;
    if (dynamicPatterns.some((re) => re.test(key))) continue;
    // Last-resort fallback: the key appears as a quoted literal ANYWHERE in
    // the source, even outside a t()/tk() call (lookup-table values, etc).
    if (rawText.includes(`"${key}"`) || rawText.includes(`'${key}'`) || rawText.includes(`\`${key}\``)) continue;
    orphans.push(key);
  }
  return orphans;
}

function run() {
  const en = readJson(path.join(LOCALES_DIR, "en.json"));
  const es = readJson(path.join(LOCALES_DIR, "es.json"));
  const enKeys = [...walk(en)];
  const esKeys = [...walk(es)];

  const missingInEs = diff(enKeys, esKeys);
  const missingInEn = diff(esKeys, enKeys);
  const parityOk = missingInEs.length === 0 && missingInEn.length === 0;

  if (!parityOk) {
    console.error("i18n parity FAILED");
    if (missingInEs.length > 0) {
      console.error(`\n  ${missingInEs.length} keys in en.json missing from es.json:`);
      for (const k of missingInEs) console.error(`    - ${k}`);
    }
    if (missingInEn.length > 0) {
      console.error(`\n  ${missingInEn.length} keys in es.json missing from en.json:`);
      for (const k of missingInEn) console.error(`    - ${k}`);
    }
  } else {
    console.log(`i18n parity OK: ${enKeys.length} keys, en.json ↔ es.json`);
  }

  // Orphan check only needs to run against one bundle's key set — en.json
  // and es.json are already confirmed (or reported) above to share the same
  // keys, so checking en.json's keys covers both.
  const refs = collectReferences();
  const orphans = findOrphans(enKeys, refs);
  const orphansOk = orphans.length === 0;

  if (!orphansOk) {
    console.error(`\ni18n orphan check FAILED`);
    console.error(
      `\n  ${orphans.length} key(s) exist in en.json/es.json but are never referenced under admin-ui/src/**:`,
    );
    for (const k of orphans) console.error(`    - ${k}`);
    console.error(
      `\n  If a key IS reachable through a dynamic pattern this script doesn't recognize yet ` +
        `(e.g. a new template-literal key construction), extend the detection in ` +
        `scripts/check-i18n.mjs rather than ignoring this failure. Otherwise, delete the key ` +
        `from both en.json and es.json.`,
    );
  } else {
    console.log(`i18n orphan check OK: 0 unreferenced keys out of ${enKeys.length}`);
  }

  process.exit(parityOk && orphansOk ? 0 : 1);
}

run();
