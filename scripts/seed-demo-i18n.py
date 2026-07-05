#!/usr/bin/env python3
"""
Build the `demo.fixtures.*` i18n keys for both en.json and es.json.

For PR 1 (foundation, no visual change), the en.json and es.json get the
SAME EN value — so ES locale users see the same EN text they saw before
(via vue-i18n's fallbackLocale mechanism). PR 2 will overwrite the ES
values with actual Spanish translations.

Idempotent: re-running won't duplicate or corrupt existing entries.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "admin-ui/src/locales/en.json")
ES = os.path.join(ROOT, "admin-ui/src/locales/es.json")

# Catalog of all translatable demo fixture strings, organized by domain.
# Each leaf value is a dict mapping field -> English literal (the same text
# already present in the fixture files — this is the canonical EN source).
# PR 2 will override the ES values with proper translations.
CATALOG: dict = {
    "demo": {
        "fixtures": {
            "tools": {
                "github.search_issues": {"description": "Search issues and pull requests"},
                "github.create_issue": {"description": "Open a new issue in a repository"},
                "github.get_repo": {"description": "Fetch repository metadata"},
                "github.list_pull_requests": {"description": "List pull requests for a repo"},
                "stripe.create_refund": {"description": "Refund a charge"},
                "stripe.get_customer": {"description": "Retrieve a customer"},
                "stripe.list_invoices": {"description": "List invoices"},
                "stripe.create_payment_intent": {"description": "Start a payment"},
                "slack.post_message": {"description": "Send a channel message"},
                "slack.list_channels": {"description": "List channels"},
                "slack.get_user": {"description": "Look up a user"},
                "internal-crm.find_account": {"description": "Search CRM accounts"},
                "internal-crm.update_deal": {"description": "Update a deal stage"},
                "weather.current": {"description": "Current conditions for a location"},
                "weather.forecast": {"description": "7-day forecast"},
                "legacy-billing.get_balance": {"description": "Legacy balance lookup"},
            },
            "bundles": {
                "support-agent": {"description": "Read-only GitHub + Slack tools for the support copilot"},
                "billing-ops": {"description": "Stripe refunds & invoice lookups for finance"},
                "readonly-explorer": {"description": "Safe, read-only slice across every backend"},
            },
            "catalog": {
                "builtin:petstore": {"description": "The canonical OpenAPI sample API — pets, orders, and inventory."},
                "custom:1": {"description": "Reusable template for spinning up a staging CRM registration."},
            },
            "discovery": {
                "list_pets": {"description": "Finds pets by status"},
                "get_pet": {"description": "Find pet by ID"},
                "add_pet": {"description": "Add a new pet to the store"},
                "update_pet": {"description": "Update an existing pet"},
                "delete_pet": {"description": "Deletes a pet"},
            },
            "keys": {
                "by_value": {
                    "Claude Desktop": {"label": "Claude Desktop"},
                    "Cursor IDE": {"label": "Cursor IDE"},
                    "CI pipeline (elevated)": {"label": "CI pipeline (elevated)"},
                    "Old prototype key": {"label": "Old prototype key"},
                },
            },
            "consumers": {
                "by_value": {
                    "Support team": {"name": "Support team"},
                    "Finance": {"name": "Finance"},
                    "Internal agents": {"name": "Internal agents"},
                },
            },
            "usage": {
                "by_value": {
                    "Claude Desktop": {"label": "Claude Desktop"},
                    "Cursor IDE": {"label": "Cursor IDE"},
                    "CI pipeline (elevated)": {"label": "CI pipeline (elevated)"},
                },
            },
            "alerts": {
                "1": {"name": "CRM circuit breaker open"},
                "2": {"name": "High error rate"},
                "3": {"name": "Usage spike detector"},
            },
            "teams": {
                "by_value": {
                    "Platform": {"name": "Platform"},
                    "Support": {"name": "Support"},
                },
            },
            "policies": {
                "by_value": {
                    "Standard read": {"name": "Standard read"},
                    "Sensitive write": {"name": "Sensitive write"},
                },
            },
            "composites": {
                "triage_issue": {"description": "Search GitHub, then post a Slack summary"},
                "refund_and_notify": {"description": "Create a Stripe refund and DM the customer owner"},
            },
            "snapshots": {
                "by_value": {
                    "before rollout": {"label": "before rollout"},
                    "add billing-ops bundle": {"label": "add billing-ops bundle"},
                    "initial": {"label": "initial"},
                },
            },
            "audit": {
                "128": {"detail": {"label": {"value": "CI pipeline (elevated)"}}},
                "122": {"detail": {"label": {"value": "before rollout"}}},
                "120": {"detail": {"name": {"value": "Support"}}},
            },
        }
    }
}


def deep_merge(base: dict, overlay: dict) -> dict:
    """Recursively merge `overlay` into `base`. Mutates and returns `base`."""
    for k, v in overlay.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def main():
    for path in (EN, ES):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        deep_merge(data, CATALOG)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        n_keys = sum(1 for _ in walk(data))
        print(f"  wrote {path}: {n_keys} total keys")


def walk(obj):
    """Yield each leaf value in a nested dict."""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from walk(v)
    else:
        yield obj


if __name__ == "__main__":
    main()