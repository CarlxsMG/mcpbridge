#!/usr/bin/env python3
"""Fix New* pages to use t('nav.<name>.label') instead of t('nav.<name>') for back-links.

The standalone 'nav.<name>' string used to exist (added for back-link
labels) but the recent script replaced those entries with the full
{label, hint} dict structure that navigation.ts expects. Update the
back-link callsites to read from the new shape.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = os.path.join(ROOT, "admin-ui/src/pages")

# nav entry names that should be suffixed with .label
NAV_NAMES = [
    "alerts",
    "keys",
    "bundles",
    "catalog",
    "composites",
    "consumers",
    "policies",
    "schedules",
    "teams",
    "users",
    "ws_proxies",
    # ws-proxies key uses underscore separator in the standalone, dot in the object
]

pattern = re.compile(r"t\(\s*['\"]nav\.(" + "|".join(NAV_NAMES) + r")['\"]\s*\)")
ws_proxies_pattern = re.compile(r"t\(\s*['\"]nav\.ws_proxies['\"]\s*\)")

count = 0
for f in os.listdir(PAGES):
    if not f.endswith(".vue"):
        continue
    path = os.path.join(PAGES, f)
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    new = pattern.sub(lambda m: f"t('nav.{m.group(1)}.label')", text)
    if new != text:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new)
        count += 1
        print(f"  rewrote {f}")

print(f"\nUpdated {count} files")