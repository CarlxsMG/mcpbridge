#!/usr/bin/env python3
"""Find t('key') calls in source files where the key is missing from es.json.

Why this matters: vue-i18n silently returns the literal key string when the
key doesn't exist in the active locale (with silentTranslationWarn: true).
That's the "I see keys on the page" bug — pages render
`pages.bundles.new.foo` instead of "Foo" because the key is in en.json but
not es.json.

This script:
  1. Loads en.json and es.json, walks the nested keys to flatten them.
  2. Greps every t("...") / t('...') literal call across .vue + .ts.
  3. Cross-references against the ES message bundle and prints every key
     that's referenced in source but missing in es.json (with the file
     path so a human can fix it).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "admin-ui/src/locales/en.json")
ES = os.path.join(ROOT, "admin-ui/src/locales/es.json")
SRC = os.path.join(ROOT, "admin-ui/src")


def flat_keys(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flat_keys(v, key))
        else:
            out[key] = v
    return out


def main():
    with open(EN, encoding="utf-8") as f:
        en = json.load(f)
    with open(ES, encoding="utf-8") as f:
        es = json.load(f)

    en_keys = set(flat_keys(en).keys())
    es_keys = set(flat_keys(es).keys())
    print(f"en keys: {len(en_keys)}")
    print(f"es keys: {len(es_keys)}")
    print(f"in en not es: {len(en_keys - es_keys)}")
    print(f"in es not en: {len(es_keys - en_keys)}")

    # Matches a `t("...")` or `t('...')` call. We deliberately require the
    # t( to be a token boundary (preceded by non-word char) so identifiers
    # like `targetKey` aren't picked up. Keys that look like documentation
    # placeholders (starting with `...` or `…`) are filtered out below.
    pattern = re.compile(r"""\bt\(\s*['"]([^'"]+)['"]""")
    # Filter out lines that are entirely JSDoc / block / line comments —
    # the audit shouldn't flag example keys mentioned in `///` comments.
    comment_re = re.compile(r"^\s*(///|//|\*|\s*\*)")
    calls: dict[str, list[str]] = {}
    for root, dirs, files in os.walk(SRC):
        if "__tests__" in root or "node_modules" in root:
            continue
        for f in files:
            if not (f.endswith(".vue") or f.endswith(".ts")):
                continue
            path = os.path.join(root, f)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            for line in text.splitlines():
                if comment_re.match(line):
                    continue
                for m in pattern.finditer(line):
                    key = m.group(1)
                    # Documentation placeholders that look like keys but
                    # aren't (e.g. `t("...")` shorthand in JSDoc, or the
                    # canonical-form examples in the helper module).
                    if key.startswith("...") or key.startswith("…"):
                        continue
                    calls.setdefault(key, []).append(path)

    print(f"\ntotal t() literal calls: {len(calls)}")

    missing_in_es = sorted(k for k in calls if k not in es_keys)
    missing_in_en = sorted(k for k in calls if k not in en_keys)
    print(f"t() keys MISSING in es.json: {len(missing_in_es)}")
    print(f"t() keys MISSING in en.json: {len(missing_in_en)}")

    print("\n=== t() keys missing in es.json ===")
    for k in missing_in_es:
        files = calls[k][:3]
        rel = [os.path.relpath(p, ROOT) for p in files]
        print(f"  {k!r}")
        for f in rel:
            print(f"      {f}")

    print("\n=== t() keys missing in en.json (likely typos) ===")
    for k in missing_in_en:
        files = calls[k][:3]
        rel = [os.path.relpath(p, ROOT) for p in files]
        print(f"  {k!r}")
        for f in rel:
            print(f"      {f}")

    sys.exit(0 if not missing_in_es else 1)


if __name__ == "__main__":
    main()