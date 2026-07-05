#!/usr/bin/env python3
"""Find t(<dynamic>) calls where the first argument is NOT a string literal.

These calls reference keys constructed at runtime (e.g. t(\`nav.\${x}\`) or
t(someVar)) and bypass the audit's literal-only check. They are worth
reviewing by hand — dynamic keys can leak raw strings if the runtime
construction doesn't match a real JSON path.

This is informational, not gating: dynamic keys are sometimes
unavoidable (e.g. namespaces per-item) and the runtime construction
is straightforward to verify by reading the component.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "admin-ui/src")

# Matches `t(EXPR)` where EXPR does not start with a quote character.
# Skip template literals and simple variable references; flag everything else.
pattern = re.compile(r"""\bt\(\s*([^'"`])""")
# Skip lines that are entirely comments.
comment_re = re.compile(r"^\s*(///|\/\/|\*|\s*\*)")
# Common globals / framework methods we don't care about.
SKIP_IDENT = re.compile(r"^(true|false|null|undefined|\w+\.\w+\(.*\))$")

found: dict[str, list[str]] = {}

for root, dirs, files in os.walk(SRC):
    if "__tests__" in root or "node_modules" in root:
        continue
    for f in files:
        if not (f.endswith(".vue") or f.endswith(".ts")):
            continue
        path = os.path.join(root, f)
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                if comment_re.match(line):
                    continue
                for m in pattern.finditer(line):
                    arg = m.group(1).lstrip()
                    # skip patterns like `t(`, `t(`, `t(someFn(`, etc.
                    if not arg or arg == " ":
                        continue
                    rel = os.path.relpath(path, ROOT)
                    found.setdefault(rel, []).append(f"L{lineno}: {line.strip()[:120]}")

if not found:
    print("No dynamic t() calls found.")
    sys.exit(0)

print(f"Files with dynamic t() calls: {len(found)}")
for f in sorted(found):
    print(f"\n  {f}")
    for line in found[f][:3]:
        print(f"    {line}")
    if len(found[f]) > 3:
        print(f"    ... and {len(found[f]) - 3} more")