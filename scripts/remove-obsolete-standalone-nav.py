#!/usr/bin/env python3
"""Remove obsolete standalone nav.<name> string entries.

The standalone form (`nav.alerts: "Alerts"`) was added by an earlier
script so back-link labels could use `t('nav.alerts')`. After the
.nav.label/.nav.hint structure was added, every back-link caller was
updated to use `t('nav.<name>.label')`, so the standalone entries are
now dead code — leaving them in the bundle would let a future typo
silently fall through to the bare string instead of a proper
parity-check failure.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "admin-ui/src/locales/en.json")
ES = os.path.join(ROOT, "admin-ui/src/locales/es.json")

STANDALONE_TO_REMOVE = [
    "alerts",
    "bundles",
    "catalog",
    "composites",
    "consumers",
    "keys",
    "policies",
    "schedules",
    "teams",
    "users",
    "ws_proxies",
    "servers",
]

for path in (EN, ES):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    nav = d.get("nav", {})
    removed = []
    for k in STANDALONE_TO_REMOVE:
        if k in nav and isinstance(nav[k], str):
            removed.append(k)
            del nav[k]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {path}: removed {removed}")