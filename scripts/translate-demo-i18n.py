#!/usr/bin/env python3
"""
Translate the demo.fixtures.* keys in es.json.

Strategy:
  - en.json keeps the EN values (canonical source of truth, seeded by
    scripts/seed-demo-i18n.py and committed as-is).
  - This script OVERWRITES the same keys in es.json with Spanish
    translations.
  - Keys not under demo.fixtures.* are untouched.
  - Idempotent: re-running replaces whatever's there with the same
    translations (so the catalog below is the single source).

The translations follow these conventions:
  - Tool names stay verbatim (they're identifiers, e.g. "search_issues").
  - Spanish uses informal "tú" for direct phrasing ("busca", "crea") to
    match how the EN side reads ("Search issues..." = imperative).
  - Acronyms (CRM, CI, IDE) stay as-is.
  - Where the EN string ends in a noun phrase we mirror that shape in
    Spanish so the UI layout doesn't shift unexpectedly.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ES = os.path.join(ROOT, "admin-ui/src/locales/es.json")

# Catalog of translations. Keys mirror the demoKey/demoKeyByValue/
# demoDetailKey paths used by the fixtures; values are the Spanish
# equivalents of the EN literal the fixtures ship as fallback.
#
# Entity-id keys use the same dot-escape as the seed script and the
# runtime helper (see admin-ui/src/demo/i18n-keys.ts): any `.` in an
# entity identifier becomes `__` so vue-i18n's nested-path walker can
# find the literal JSON key.
def safe(s: str) -> str:
    return s.replace(".", "__")


TRANSLATIONS: dict = {
    "demo": {
        "fixtures": {
            "tools": {
                safe("github.search_issues"): {"description": "Buscar issues y pull requests"},
                safe("github.create_issue"): {"description": "Abrir un nuevo issue en un repositorio"},
                safe("github.get_repo"): {"description": "Obtener metadatos del repositorio"},
                safe("github.list_pull_requests"): {"description": "Listar pull requests de un repositorio"},
                safe("stripe.create_refund"): {"description": "Reembolsar un cargo"},
                safe("stripe.get_customer"): {"description": "Consultar un cliente"},
                safe("stripe.list_invoices"): {"description": "Listar facturas"},
                safe("stripe.create_payment_intent"): {"description": "Iniciar un pago"},
                safe("slack.post_message"): {"description": "Enviar un mensaje a un canal"},
                safe("slack.list_channels"): {"description": "Listar canales"},
                safe("slack.get_user"): {"description": "Buscar un usuario"},
                safe("internal-crm.find_account"): {"description": "Buscar cuentas en el CRM"},
                safe("internal-crm.update_deal"): {"description": "Actualizar la etapa de una oportunidad"},
                safe("weather.current"): {"description": "Clima actual en una ubicación"},
                safe("weather.forecast"): {"description": "Pronóstico a 7 días"},
                safe("legacy-billing.get_balance"): {"description": "Consulta de saldo heredada"},
            },
            "bundles": {
                "support-agent": {"description": "Herramientas de GitHub y Slack de solo lectura para el copiloto de soporte"},
                "billing-ops": {"description": "Reembolsos de Stripe y consultas de facturas para finanzas"},
                "readonly-explorer": {"description": "Vista segura y de solo lectura sobre todos los backends"},
            },
            "catalog": {
                "builtin:petstore": {
                    "description": "La API de ejemplo canónica de OpenAPI — mascotas, pedidos e inventario."
                },
                "custom:1": {
                    "description": "Plantilla reutilizable para crear un registro de CRM en staging."
                },
            },
            "discovery": {
                "list_pets": {"description": "Busca mascotas por estado"},
                "get_pet": {"description": "Buscar mascota por ID"},
                "add_pet": {"description": "Añadir una mascota nueva a la tienda"},
                "update_pet": {"description": "Actualizar una mascota existente"},
                "delete_pet": {"description": "Eliminar una mascota"},
            },
            "keys": {
                "by_value": {
                    "Claude Desktop": {"label": "Claude Desktop"},
                    "Cursor IDE": {"label": "Cursor IDE"},
                    "CI pipeline (elevated)": {"label": "Pipeline de CI (elevado)"},
                    "Old prototype key": {"label": "Llave prototipo antigua"},
                },
            },
            "consumers": {
                "by_value": {
                    "Support team": {"name": "Equipo de soporte"},
                    "Finance": {"name": "Finanzas"},
                    "Internal agents": {"name": "Agentes internos"},
                },
            },
            "usage": {
                "by_value": {
                    "Claude Desktop": {"label": "Claude Desktop"},
                    "Cursor IDE": {"label": "Cursor IDE"},
                    "CI pipeline (elevated)": {"label": "Pipeline de CI (elevado)"},
                },
            },
            "alerts": {
                "1": {"name": "Disyuntor del CRM abierto"},
                "2": {"name": "Tasa de error alta"},
                "3": {"name": "Detector de picos de uso"},
            },
            "teams": {
                "by_value": {
                    "Platform": {"name": "Plataforma"},
                    "Support": {"name": "Soporte"},
                },
            },
            "policies": {
                "by_value": {
                    "Standard read": {"name": "Lectura estándar"},
                    "Sensitive write": {"name": "Escritura sensible"},
                },
            },
            "composites": {
                "triage_issue": {"description": "Buscar en GitHub y luego publicar un resumen en Slack"},
                "refund_and_notify": {
                    "description": "Crear un reembolso en Stripe y enviar un DM al responsable del cliente"
                },
            },
            "snapshots": {
                "by_value": {
                    "before rollout": {"label": "antes del despliegue"},
                    "add billing-ops bundle": {"label": "añadir bundle billing-ops"},
                    "initial": {"label": "inicial"},
                },
            },
            "audit": {
                "128": {"detail": {"label": {"value": "Pipeline de CI (elevado)"}}},
                "122": {"detail": {"label": {"value": "antes del despliegue"}}},
                "120": {"detail": {"name": {"value": "Soporte"}}},
            },
        }
    }
}


def deep_merge(base: dict, overlay: dict) -> dict:
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def main():
    with open(ES, "r", encoding="utf-8") as f:
        es_data = json.load(f)
    deep_merge(es_data, TRANSLATIONS)
    with open(ES, "w", encoding="utf-8") as f:
        json.dump(es_data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  wrote {ES}")


if __name__ == "__main__":
    main()