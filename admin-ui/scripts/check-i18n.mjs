#!/usr/bin/env node
// Validate that every key present in en.json is also present in es.json (and
// vice-versa for sanity). Exits non-zero with a clear per-path report on any
// drift so a missing translation gets caught at CI time, not at runtime.
//
// Future languages: extend this script to load each locale under
// `src/locales/*.json` and assert parity against en.json.
//
// Usage: bun run scripts/check-i18n.mjs   (also wrapped as `lint:i18n`)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "..", "src", "locales");

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

function run() {
  const en = readJson(path.join(LOCALES_DIR, "en.json"));
  const es = readJson(path.join(LOCALES_DIR, "es.json"));
  const enKeys = [...walk(en)];
  const esKeys = [...walk(es)];

  const missingInEs = diff(enKeys, esKeys);
  const missingInEn = diff(esKeys, enKeys);

  if (missingInEs.length === 0 && missingInEn.length === 0) {
    console.log(`i18n parity OK: ${enKeys.length} keys, en.json ↔ es.json`);
    process.exit(0);
  }

  console.error("i18n parity FAILED");
  if (missingInEs.length > 0) {
    console.error(`\n  ${missingInEs.length} keys in en.json missing from es.json:`);
    for (const k of missingInEs) console.error(`    - ${k}`);
  }
  if (missingInEn.length > 0) {
    console.error(`\n  ${missingInEn.length} keys in es.json missing from en.json:`);
    for (const k of missingInEn) console.error(`    - ${k}`);
  }
  process.exit(1);
}

run();
