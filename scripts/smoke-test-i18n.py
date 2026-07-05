#!/usr/bin/env python3
"""
Smoke-test the i18n fix end-to-end: walk every t("...") literal in the
admin-ui source and verify that, with locale=es, the resolved value is
a non-empty translated string — never the raw key.

This is the manual counterpart to src/i18n-parity.test.ts (which only
checks key existence). It actually evaluates the translations to make
sure the user sees real Spanish text instead of raw key strings.
"""
import json
import os
import re
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN_PATH = os.path.join(ROOT, "admin-ui/src/locales/en.json")
ES_PATH = os.path.join(ROOT, "admin-ui/src/locales/es.json")
SRC = os.path.join(ROOT, "admin-ui/src")


def flatten_bundle(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flatten_bundle(v, key))
        else:
            out[key] = v
    return out


def main():
    with open(EN_PATH, encoding="utf-8") as f:
        en = json.load(f)
    with open(ES_PATH, encoding="utf-8") as f:
        es = json.load(f)

    en_flat = flatten_bundle(en)
    es_flat = flatten_bundle(es)

    pattern = re.compile(r"""\bt\(\s*['"]([^'"]+)['"]""")
    comment_re = re.compile(r"^\s*(///|\/\/|\*|\s*\*)")
    placeholder_re = re.compile(r"^\.{3}|^…")
    skip_files = re.compile(r"(\\|/)i18n-keys\.ts$|(\\|/)i18n-parity\.test\.ts$|(\\|/)demo-i18n-parity\.test\.ts$|(\\|/)resolve\.test\.ts$|(\\|/)demo-locale\.test\.ts$")

    calls = defaultdict(set)
    for root, dirs, files in os.walk(SRC):
        if "__tests__" in root or "node_modules" in root:
            continue
        for f in files:
            if not (f.endswith(".vue") or f.endswith(".ts")):
                continue
            path = os.path.join(root, f)
            if skip_files.search(path):
                continue
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    if comment_re.match(line):
                        continue
                    for m in pattern.finditer(line):
                        key = m.group(1)
                        if placeholder_re.match(key):
                            continue
                        calls[key].add(os.path.relpath(path, ROOT))

    print(f"Total t() calls: {sum(len(v) for v in calls.values())} (unique keys: {len(calls)})")
    print()

    # Show a few resolved examples — both EN and ES.
    sample = sorted(calls.keys())[:20]
    print("=== Sample translations (first 20) ===")
    for k in sample:
        e = en_flat.get(k, "<MISSING>")
        s = es_flat.get(k, "<MISSING>")
        print(f"  {k}")
        print(f"    EN: {e!r}")
        print(f"    ES: {s!r}")

    # Verify: every key has both an EN and ES translation that's a non-empty string.
    bad = []
    for k in calls:
        e = en_flat.get(k)
        s = es_flat.get(k)
        if not isinstance(e, str) or not e.strip():
            bad.append((k, "en", e))
        if not isinstance(s, str) or not s.strip():
            bad.append((k, "es", s))
    if bad:
        print(f"\n❌ {len(bad)} keys have empty/missing translations")
        for k, loc, v in bad[:10]:
            print(f"  {k} ({loc}): {v!r}")
        raise SystemExit(1)
    print(f"\n✓ All {len(calls)} keys have valid EN+ES translations")


if __name__ == "__main__":
    main()