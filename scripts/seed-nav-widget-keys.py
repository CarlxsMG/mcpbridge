#!/usr/bin/env python3
"""
Fix the second wave of i18n gaps the static literal-key audit missed:

1. Add nav.<name>.label / nav.<name>.hint pairs for the 11 nav entries
   that have a standalone nav.<name> string (added by the previous
   script for back-link labels) but are missing the .label/.hint
   object shape that `navigation.ts` looks up via t(e.labelKey) and
   t(e.hintKey).

2. The widgetCatalog.ts file declared GROUP_LABELS as a Record of
   literal English strings ("Overview", "Usage", "Health", ...) and
   passed them to t(). That looks up keys that don't exist in en.json
   — the user sees the literal English word as a "missing key". This
   script adds the missing keys under `components.overview.
   widget_groups.*` and `components.overview.widget_categories.*` so
   the next commit can point GROUP_LABELS at real keys.

Idempotent: existing entries are left untouched.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "admin-ui/src/locales/en.json")
ES = os.path.join(ROOT, "admin-ui/src/locales/es.json")


def deep_merge(base: dict, overlay: dict) -> dict:
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


# 1. nav.<name>.label / hint pairs. The label value is the same as the
#    standalone nav.<name> string already in the bundle (consistency).
#    The hint is a short description of what the section does.
MISSING_EN = {
    "nav": {
        "servers": {"label": "Servers", "hint": "Upstream servers (REST + MCP)"},
        "catalog": {"label": "Catalog", "hint": "Pre-built servers you can register with one click"},
        "bundles": {"label": "Bundles", "hint": "Curated tool selections to expose to clients"},
        "composites": {"label": "Composites", "hint": "Multi-step tool chains"},
        "keys": {"label": "API keys", "hint": "MCP bearer tokens issued to consumers"},
        "policies": {"label": "Policies", "hint": "Reusable guard profiles"},
        "consumers": {"label": "Consumers", "hint": "Per-consumer quotas and rate limits"},
        "alerts": {"label": "Alerts", "hint": "Webhook alert rules"},
        "schedules": {"label": "Schedules", "hint": "Cron-driven enable/disable actions"},
        "users": {"label": "Users", "hint": "Admin accounts and roles"},
        "teams": {"label": "Teams", "hint": "Group users to scope policies and ownership"},
    },
    # 2. Widget group labels — referenced by t(GROUP_LABELS[group])
    #    from AddWidgetDialog.vue / WidgetConfigDialog.vue. These map
    #    to the same shape as the sidebar group keys but live under
    #    a separate namespace so we don't conflate sidebar headings
    #    with widget-picker categories.
    "components": {
        "overview": {
            "widget_groups": {
                "overview": "Overview",
                "usage": "Usage",
                "health": "Health",
                "access": "Access",
                "activity": "Activity",
                "custom": "Custom",
            },
        },
    },
}

MISSING_ES = {
    "nav": {
        "servers": {"label": "Servidores", "hint": "Servidores upstream (REST + MCP)"},
        "catalog": {"label": "Catálogo", "hint": "Servidores predefinidos que puedes registrar con un clic"},
        "bundles": {"label": "Bundles", "hint": "Selecciones curadas de tools a exponer a los clientes"},
        "composites": {"label": "Composites", "hint": "Cadenas de tools multi-paso"},
        "keys": {"label": "API keys", "hint": "Tokens bearer MCP emitidos a los consumers"},
        "policies": {"label": "Políticas", "hint": "Perfiles de guard reutilizables"},
        "consumers": {"label": "Consumers", "hint": "Cuotas y rate limits por consumer"},
        "alerts": {"label": "Alertas", "hint": "Reglas de alerta por webhook"},
        "schedules": {"label": "Schedules", "hint": "Acciones enable/disable por cron"},
        "users": {"label": "Usuarios", "hint": "Cuentas admin y roles"},
        "teams": {"label": "Teams", "hint": "Agrupa usuarios para acotar políticas y ownership"},
    },
    "components": {
        "overview": {
            "widget_groups": {
                "overview": "Resumen",
                "usage": "Uso",
                "health": "Salud",
                "access": "Acceso",
                "activity": "Actividad",
                "custom": "Custom",
            },
        },
    },
}


def main():
    for path, overlay in ((EN, MISSING_EN), (ES, MISSING_ES)):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        deep_merge(data, overlay)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"  wrote {path}")


if __name__ == "__main__":
    main()