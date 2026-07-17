#!/usr/bin/env bun
// Validates the two admin-ui locale bundles three ways:
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
//   3. Source → bundle — every key passed as a *literal* to t()/tk() in the
//      source actually exists in the bundles. Parity (1) only compares the two
//      bundles to each other, so a key referenced in code but present in
//      NEITHER bundle slips through both (1) and (2); vue-i18n then renders the
//      raw key string ("pages.foo.bar") on the page. This is the check the
//      retired Python i18n-audit workflow used to own, folded back in here so
//      the whole invariant lives in one Bun/TS gate.
//
//   4. Value equality — every key whose es.json value is byte-for-byte
//      identical to its en.json value is flagged UNLESS it's in the curated
//      allowlist (scripts/i18n-identical-allowlist.mjs). Parity (1) only
//      asserts a key EXISTS in both bundles, never that its Spanish value was
//      actually translated — so a string copy-pasted into es.json and never
//      localized ships as English on live Spanish pages and passes (1)-(3)
//      forever. The allowlist enumerates the strings that are SUPPOSED to read
//      identically (brand/feature nouns, technical terms, code examples,
//      format skeletons, proper names); anything else that matches is a real
//      missing translation.
//
//   5. Eaten literals — every key whose value carries a vue-i18n named
//      placeholder ({ident}) but that is only ever referenced as a bare literal
//      t()/tk() with NO params object renders that placeholder verbatim on the
//      page. Checks (1)-(4) all pass such a key (it exists in both bundles, is
//      referenced, resolves, and its es value can differ), yet a user sees the
//      raw "{name}"/"{base}" text. When the braces are meant to render
//      literally, escape them in BOTH bundles with vue-i18n literal
//      interpolation ({'{'}base{'}'}); otherwise pass the param at the call
//      site. Keys reached only through dynamic key-construction are skipped
//      (their params can't be seen statically).
//
// Future languages: extend this script to load each locale under
// `src/locales/*.json` and assert parity + orphan-freedom against en.json.
//
// Usage: bun run scripts/check-i18n.mjs   (also wrapped as `lint:i18n`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identicalAllowlist } from "./i18n-identical-allowlist.mjs";

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

// Flatten a locale bundle to a Map of dotted-key → value (same key shape
// `walk()` yields), keeping the leaf value so the value-equality check (4) can
// compare es against en per key.
function flatten(obj, prefix = "", out = new Map()) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out.set(prefix, obj);
    return out;
  }
  for (const key of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    flatten(obj[key], next, out);
  }
  return out;
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
  // Keys passed as a plain string literal to t()/tk() — the subset that can be
  // checked in the source→bundle direction (a composed/dynamic key can't be
  // matched against the bundle as an exact string).
  const literalReferenced = new Set();
  const dynamicPatterns = [];

  function addKey(key, literal = false) {
    if (placeholderRe.test(key)) return;
    referenced.add(key);
    if (literal) literalReferenced.add(key);
  }

  const files = walkSourceFiles(SRC_DIR);
  const fileTexts = files.map((f) => fs.readFileSync(f, "utf8"));

  for (const text of fileTexts) {
    for (const line of text.split("\n")) {
      if (commentRe.test(line)) continue;

      for (const m of line.matchAll(tCallRe)) addKey(m[1], true);
      for (const m of line.matchAll(castCallRe)) addKey(m[1], true);

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

  const rawText = fileTexts.join("\n");

  // Keys passed a params object — a literal t()/tk() call with a second argument
  // (a comma after the key literal). A vue-i18n `{placeholder}` in a message only
  // renders when its call site supplies these params; recording "was ever called
  // with params" lets the eaten-literal check (5) tell a real interpolation from a
  // placeholder that ships verbatim. Scanned over the whole joined source (not
  // line-by-line) so a params object wrapped onto the next line still counts; the
  // bias toward marking a key param-referenced (even from a comment) matches this
  // file's overall lean toward NOT flagging when in doubt.
  const paramReferenced = new Set();
  const tCallParamRe = /\b(?:t|tk)\(\s*['"]([^'"]+)['"]\s*,/g;
  for (const m of rawText.matchAll(tCallParamRe)) paramReferenced.add(m[1]);

  return { referenced, literalReferenced, paramReferenced, dynamicPatterns, rawText };
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

  // Source → bundle: a literal t()/tk() key present in NEITHER bundle is a
  // runtime bug that parity (bundle↔bundle) and orphans (bundle→source) both
  // miss (see the header). enKeys and esKeys are already asserted equal by the
  // parity check above, so checking en covers both.
  const enKeySet = new Set(enKeys);
  const missingFromBundle = [...refs.literalReferenced].filter((k) => !enKeySet.has(k)).sort();
  const sourceOk = missingFromBundle.length === 0;

  if (!sourceOk) {
    console.error(`\ni18n source→bundle check FAILED`);
    console.error(
      `\n  ${missingFromBundle.length} literal t()/tk() key(s) referenced in source but absent from en.json/es.json:`,
    );
    for (const k of missingFromBundle) console.error(`    - ${k}`);
    console.error(
      `\n  vue-i18n renders these as the raw key string at runtime — add them to both bundles (or fix the typo).`,
    );
  } else {
    console.log(`i18n source→bundle check OK: every literal t()/tk() key resolves`);
  }

  // Value equality: an es value byte-for-byte identical to its en value is an
  // untranslated string unless it's a deliberately-identical term/example in
  // the allowlist. Only meaningful for keys present (and equal-length) in both
  // bundles, which parity above already asserts; guard on presence anyway so a
  // parity failure doesn't cascade into noise here.
  const enFlat = flatten(en);
  const esFlat = flatten(es);
  const untranslated = [];
  for (const key of enKeys) {
    if (identicalAllowlist.has(key)) continue;
    const enVal = enFlat.get(key);
    const esVal = esFlat.get(key);
    if (typeof enVal === "string" && typeof esVal === "string" && enVal === esVal) {
      untranslated.push(key);
    }
  }
  const valuesOk = untranslated.length === 0;

  if (!valuesOk) {
    console.error(`\ni18n value-equality check FAILED`);
    console.error(
      `\n  ${untranslated.length} key(s) have an es.json value identical to en.json (likely untranslated):`,
    );
    for (const k of untranslated) console.error(`    - ${k} => ${JSON.stringify(enFlat.get(k))}`);
    console.error(
      `\n  Translate each in es.json. If a string is SUPPOSED to read identically in both ` +
        `languages (brand/feature noun, technical term, code example, format skeleton, proper ` +
        `name), add its key to scripts/i18n-identical-allowlist.mjs instead.`,
    );
  } else {
    console.log(`i18n value-equality check OK: every es value differs from en (or is allowlisted)`);
  }

  // Eaten literals: a value with a vue-i18n {placeholder} that is only ever
  // referenced as a bare literal t()/tk() (no params object anywhere) renders the
  // placeholder verbatim at runtime — the bug that shipped "{name}" on the
  // Bundles subtitle and "{base}" on the context-budget provider labels. Only
  // literal-referenced keys are considered (a placeholder passed via a dynamic
  // key can't have its params inspected here); enFlat/enKeys are reused from the
  // value-equality section above.
  const namedPlaceholderRe = /\{[A-Za-z_]\w*\}/;
  const eatenLiterals = enKeys.filter((key) => {
    const val = enFlat.get(key);
    if (typeof val !== "string" || !namedPlaceholderRe.test(val)) return false;
    return refs.literalReferenced.has(key) && !refs.paramReferenced.has(key);
  });
  const eatenOk = eatenLiterals.length === 0;

  if (!eatenOk) {
    console.error(`\ni18n eaten-literal check FAILED`);
    console.error(
      `\n  ${eatenLiterals.length} key(s) carry a vue-i18n {placeholder} but are called as a bare literal t()/tk() with no params — the placeholder ships verbatim on the page:`,
    );
    for (const k of eatenLiterals) console.error(`    - ${k} => ${JSON.stringify(enFlat.get(k))}`);
    console.error(
      `\n  Pass the interpolation param at the call site, or — if the braces must render literally — escape ` +
        `them in en.json AND es.json with vue-i18n literal interpolation, e.g. {'{'}base{'}'}.`,
    );
  } else {
    console.log(`i18n eaten-literal check OK: every {placeholder} key is passed params (or escaped)`);
  }

  process.exit(parityOk && orphansOk && sourceOk && valuesOk && eatenOk ? 0 : 1);
}

run();
