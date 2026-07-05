#!/usr/bin/env python3
"""Group missing-key warnings by file, top offenders first."""
import json
import os
import re
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "admin-ui/src/locales/en.json")
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
    keys = set(flat_keys(en).keys())

    pattern = re.compile(r"""\bt\(\s*['"]([^'"]+)['"]""")
    calls: dict[str, list[str]] = defaultdict(list)
    for root, dirs, files in os.walk(SRC):
        if "__tests__" in root or "node_modules" in root:
            continue
        for f in files:
            if not (f.endswith(".vue") or f.endswith(".ts")):
                continue
            path = os.path.join(root, f)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            for m in pattern.finditer(text):
                calls[m.group(1)].append(path)

    # Filter to keys missing in en.json (i.e. everywhere)
    missing = {k: v for k, v in calls.items() if k not in keys and not k.startswith("...")}

    by_file: dict[str, list[str]] = defaultdict(list)
    for k, paths in missing.items():
        for p in paths:
            by_file[p].append(k)

    print(f"Total missing keys: {sum(len(v) for v in missing.values())} (unique: {len(missing)})")
    print()
    print("=== Top 20 files by missing-key count ===")
    for f, ks in sorted(by_file.items(), key=lambda x: -len(x[1]))[:20]:
        rel = os.path.relpath(f, ROOT)
        print(f"\n  {len(ks):3d} missing  {rel}")
        for k in ks:
            print(f"           {k}")


if __name__ == "__main__":
    main()