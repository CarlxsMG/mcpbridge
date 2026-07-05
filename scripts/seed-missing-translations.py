#!/usr/bin/env python3
"""
Seed ALL missing i18n keys into en.json + es.json with sensible defaults.

The previous i18n session added translations for a lot of pages but
missed several — BundleDetailPage, ServerDetailPage, TrafficPage,
UsagePage, UsersPage all have `t()` calls referencing keys that were
never added to the locale bundles. vue-i18n silently returns the key
string when missing (with silentFallbackWarn: true), so users see
`pages.bundle_detail.delete_bundle` instead of "Delete bundle".

This script seeds both en.json and es.json with:
  - All missing keys under `pages.bundle_detail.*`
  - All missing keys under `pages.server_detail.*`
  - All missing keys under `pages.traffic.*`
  - All missing keys under `pages.usage.*`
  - All missing keys under `pages.users.*`
  - The `nav.<entity>` keys (back-link labels) used by PageHeader in
    the New* pages
  - `pages.keys.new.mint_key`

EN values are chosen to read naturally in the existing UI. ES values
are translations that match the same shape.

Idempotent: missing keys are added; existing keys are left alone.
Re-runnable: safe to re-run after more keys land.
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


MISSING_EN = {
    "pages": {
        "bundle_detail": {
            "disable_bundle": "Disable bundle",
            "enable_bundle": "Enable bundle",
            "share_link": "Share install link",
            "deleting": "Deleting…",
            "delete_bundle": "Delete bundle",
            "description_label": "Description",
            "description_placeholder": "What does this bundle do?",
            "tools_heading": "Tools in bundle ({count})",
            "save_tools": "Save tool selection",
            "unsaved_tools": "You have unsaved tool changes.",
            "confirm": {
                "delete_title": "Delete this bundle?",
                "delete_message": "Delete bundle “{name}”? Tools themselves stay registered — only the curated selection goes away.",
                "delete_cta": "Delete bundle “{name}”",
                "leave_title": "Discard tool changes?",
                "leave_message": "You have unsaved tool selections. Leaving now will discard them.",
                "leave_cta": "Discard changes",
            },
            "errors": {
                "load_failed": "Failed to load bundle.",
                "save_description_failed": "Failed to save description.",
                "save_tools_failed": "Failed to save tool selection.",
                "delete_failed": "Failed to delete bundle.",
                "toggle_failed": "Failed to toggle bundle state.",
            },
        },
        "server_detail": {
            "tabs": {
                "tools": "Tools",
                "settings": "Settings",
            },
            "not_connected": "Server is not currently connected.",
            "resetting": "Resetting…",
            "reset_breaker": "Reset circuit breaker",
            "mcp_url": "MCP URL",
            "transport": "Transport",
            "health_url": "Health URL",
            "base_url": "Base URL",
            "consecutive_failures": "Consecutive failures",
            "guards_aria": "Tool guards",
            "guards_heading": "Per-tool guards",
            "tool_not_found": "Tool not found on this server.",
            "confirm": {
                "disable_title": "Disable this server?",
                "disable_message": "Disable {name}? Its tools will stop being advertised until you re-enable it.",
                "disable_cta": "Disable server",
            },
        },
        "traffic": {
            "subtitle_p1": "Every tool call that hits this admin gateway lands here — both successful and failed.",
            "subtitle_p2": "Filter by client or tool, drill into a record to see the exact request/response, or replay it against the current upstream.",
            "errors_only": "Errors only",
            "filtering": "Filtering…",
            "filter_button": "Filter",
            "empty_p1": "No traffic in the selected window.",
            "empty_p2": "Adjust the filter or wait for fresh traffic to roll in.",
            "pagination_label": "Pagination",
            "filters": {
                "client_label": "Client",
                "tool_label": "Tool",
            },
            "table": {
                "time": "Time",
                "client_tool": "Client / tool",
                "status": "Status",
                "preview": "Response preview",
                "status_error": "Error",
                "status_ok": "OK",
            },
            "chart": {
                "title": "Calls vs errors over time",
                "primary_label": "Calls",
                "secondary_label": "Errors",
            },
            "replay": {
                "tooltip": "Replay this call against the current upstream",
                "replay": "Replay",
                "replaying": "Replaying…",
                "succeeded": "Replay succeeded.",
                "failed": "Replay failed.",
                "no_content": "The replay returned no content.",
                "note_p1": "This replays the call against whatever the server is currently pointing at.",
            },
            "confirm": {
                "replay_title": "Replay this call?",
                "replay_message": "This will re-run the exact same call against the current upstream.",
                "replay_cta": "Replay",
            },
        },
        "usage": {
            "errors_hint": "Errors include any non-2xx response or thrown exception at the dispatch layer.",
            "time_window_aria": "Time window",
            "truncated_hint": "Showing the top entries — drill in to see the rest.",
            "stat": {
                "calls": "Calls",
                "errors": "Errors",
                "error_rate": "Error rate",
                "avg_latency": "Avg latency",
                "max_latency": "Max latency",
                "active_tools": "Active tools",
            },
            "section": {
                "top_tools": "Top tools",
                "by_key": "By API key",
            },
            "table": {
                "client": "Client",
                "tool": "Tool",
                "calls": "Calls",
                "errors": "Errors",
                "error_rate": "Error rate",
                "avg": "Avg (ms)",
                "max": "Max (ms)",
                "key": "API key",
            },
            "chart": {
                "calls_errors": "Calls vs errors",
                "calls_by_key": "Calls by API key",
                "top_tools": "Top tools",
                "primary_label": "Calls",
                "secondary_label": "Errors",
            },
            "empty": {
                "no_calls": "No calls in the selected window.",
                "no_attributed": "No calls attributed to a registered API key.",
            },
        },
        "users": {
            "add_user": "Add user",
            "empty": "No users yet.",
            "you_tag": "(you)",
            "yes": "Yes",
            "no": "No",
            "last_admin_locked": "Cannot remove or demote the last admin.",
            "team": {
                "none": "No team",
                "create": "Create team",
                "change_locked": "Team changes are locked while this user is the last admin.",
            },
            "table": {
                "team": "Team",
                "active": "Active",
            },
            "roles": {
                "admin": "Admin",
                "operator": "Operator",
                "auditor": "Auditor",
                "viewer": "Viewer",
            },
            "confirm": {
                "delete_title": "Delete this user?",
                "delete_message": "Delete user {username}? They will no longer be able to sign in.",
                "delete_cta": "Delete user",
                "role_title": "Change role for {username}?",
                "role_cta": "Change role",
                "role_cta_default": "Change role to {role}",
                "role_self": "You are about to change your own role.",
                "role_other": "You are about to change {username}'s role from {current} to {next}.",
                "team_title": "Change team for {username}?",
                "team_base": "Change {username}'s team?",
                "team_cta": "Change team",
                "team_cta_default": "Change team to {team}",
                "team_self_warning": "You are about to change your own team.",
            },
        },
        "keys": {
            "new": {
                "mint_key": "Mint key",
            },
        },
    },
    "nav": {
        "alerts": "Alerts",
        "bundles": "Bundles",
        "catalog": "Catalog",
        "composites": "Composites",
        "consumers": "Consumers",
        "keys": "API keys",
        "policies": "Policies",
        "schedules": "Schedules",
        "servers": "Servers",
        "teams": "Teams",
        "users": "Users",
        "ws_proxies": "WebSocket proxies",
    },
}

MISSING_ES = {
    "pages": {
        "bundle_detail": {
            "disable_bundle": "Desactivar bundle",
            "enable_bundle": "Activar bundle",
            "share_link": "Compartir enlace de instalación",
            "deleting": "Eliminando…",
            "delete_bundle": "Eliminar bundle",
            "description_label": "Descripción",
            "description_placeholder": "¿Qué hace este bundle?",
            "tools_heading": "Tools en el bundle ({count})",
            "save_tools": "Guardar selección de tools",
            "unsaved_tools": "Tienes cambios de tools sin guardar.",
            "confirm": {
                "delete_title": "¿Eliminar este bundle?",
                "delete_message": "¿Eliminar el bundle “{name}”? Las tools siguen registradas — solo se va la selección curada.",
                "delete_cta": "Eliminar bundle “{name}”",
                "leave_title": "¿Descartar los cambios de tools?",
                "leave_message": "Tienes selecciones de tools sin guardar. Si sales ahora se perderán.",
                "leave_cta": "Descartar cambios",
            },
            "errors": {
                "load_failed": "No se pudo cargar el bundle.",
                "save_description_failed": "No se pudo guardar la descripción.",
                "save_tools_failed": "No se pudo guardar la selección de tools.",
                "delete_failed": "No se pudo eliminar el bundle.",
                "toggle_failed": "No se pudo cambiar el estado del bundle.",
            },
        },
        "server_detail": {
            "tabs": {
                "tools": "Tools",
                "settings": "Configuración",
            },
            "not_connected": "El servidor no está conectado actualmente.",
            "resetting": "Reiniciando…",
            "reset_breaker": "Reiniciar disyuntor",
            "mcp_url": "URL MCP",
            "transport": "Transporte",
            "health_url": "URL de health",
            "base_url": "URL base",
            "consecutive_failures": "Fallos consecutivos",
            "guards_aria": "Guards de tools",
            "guards_heading": "Guards por tool",
            "tool_not_found": "Tool no encontrada en este servidor.",
            "confirm": {
                "disable_title": "¿Desactivar este servidor?",
                "disable_message": "¿Desactivar {name}? Sus tools dejarán de anunciarse hasta que lo reactives.",
                "disable_cta": "Desactivar servidor",
            },
        },
        "traffic": {
            "subtitle_p1": "Cada llamada de tool que llega a este gateway admin aparece aquí — exitosa o fallida.",
            "subtitle_p2": "Filtra por cliente o tool, profundiza en un registro para ver la request/response exacta, o replícala contra el upstream actual.",
            "errors_only": "Solo errores",
            "filtering": "Filtrando…",
            "filter_button": "Filtrar",
            "empty_p1": "No hay tráfico en la ventana seleccionada.",
            "empty_p2": "Ajusta el filtro o espera a que entre tráfico nuevo.",
            "pagination_label": "Paginación",
            "filters": {
                "client_label": "Cliente",
                "tool_label": "Tool",
            },
            "table": {
                "time": "Hora",
                "client_tool": "Cliente / tool",
                "status": "Estado",
                "preview": "Vista previa de respuesta",
                "status_error": "Error",
                "status_ok": "OK",
            },
            "chart": {
                "title": "Llamadas vs errores a lo largo del tiempo",
                "primary_label": "Llamadas",
                "secondary_label": "Errores",
            },
            "replay": {
                "tooltip": "Re-ejecutar esta llamada contra el upstream actual",
                "replay": "Re-ejecutar",
                "replaying": "Re-ejecutando…",
                "succeeded": "Replay exitoso.",
                "failed": "Replay falló.",
                "no_content": "El replay no devolvió contenido.",
                "note_p1": "Esto re-ejecuta la llamada contra lo que el servidor apunte actualmente.",
            },
            "confirm": {
                "replay_title": "¿Re-ejecutar esta llamada?",
                "replay_message": "Esto re-ejecutará la misma llamada contra el upstream actual.",
                "replay_cta": "Re-ejecutar",
            },
        },
        "usage": {
            "errors_hint": "Los errores incluyen cualquier respuesta no-2xx o excepción en la capa de dispatch.",
            "time_window_aria": "Ventana de tiempo",
            "truncated_hint": "Mostrando las entradas principales — profundiza para ver el resto.",
            "stat": {
                "calls": "Llamadas",
                "errors": "Errores",
                "error_rate": "Tasa de error",
                "avg_latency": "Latencia media",
                "max_latency": "Latencia máx.",
                "active_tools": "Tools activas",
            },
            "section": {
                "top_tools": "Top tools",
                "by_key": "Por API key",
            },
            "table": {
                "client": "Cliente",
                "tool": "Tool",
                "calls": "Llamadas",
                "errors": "Errores",
                "error_rate": "Tasa de error",
                "avg": "Media (ms)",
                "max": "Máx (ms)",
                "key": "API key",
            },
            "chart": {
                "calls_errors": "Llamadas vs errores",
                "calls_by_key": "Llamadas por API key",
                "top_tools": "Top tools",
                "primary_label": "Llamadas",
                "secondary_label": "Errores",
            },
            "empty": {
                "no_calls": "No hay llamadas en la ventana seleccionada.",
                "no_attributed": "No hay llamadas atribuidas a una API key registrada.",
            },
        },
        "users": {
            "add_user": "Añadir usuario",
            "empty": "No hay usuarios todavía.",
            "you_tag": "(tú)",
            "yes": "Sí",
            "no": "No",
            "last_admin_locked": "No se puede eliminar ni degradar al último admin.",
            "team": {
                "none": "Sin team",
                "create": "Crear team",
                "change_locked": "Los cambios de team están bloqueados mientras este usuario sea el último admin.",
            },
            "table": {
                "team": "Team",
                "active": "Activo",
            },
            "roles": {
                "admin": "Admin",
                "operator": "Operador",
                "auditor": "Auditor",
                "viewer": "Visor",
            },
            "confirm": {
                "delete_title": "¿Eliminar este usuario?",
                "delete_message": "¿Eliminar al usuario {username}? Ya no podrá iniciar sesión.",
                "delete_cta": "Eliminar usuario",
                "role_title": "¿Cambiar rol de {username}?",
                "role_cta": "Cambiar rol",
                "role_cta_default": "Cambiar rol a {role}",
                "role_self": "Estás a punto de cambiar tu propio rol.",
                "role_other": "Estás a punto de cambiar el rol de {username} de {current} a {next}.",
                "team_title": "¿Cambiar team de {username}?",
                "team_base": "¿Cambiar el team de {username}?",
                "team_cta": "Cambiar team",
                "team_cta_default": "Cambiar team a {team}",
                "team_self_warning": "Estás a punto de cambiar tu propio team.",
            },
        },
        "keys": {
            "new": {
                "mint_key": "Generar key",
            },
        },
    },
    "nav": {
        "alerts": "Alertas",
        "bundles": "Bundles",
        "catalog": "Catálogo",
        "composites": "Composites",
        "consumers": "Consumers",
        "keys": "API keys",
        "policies": "Políticas",
        "schedules": "Schedules",
        "servers": "Servidores",
        "teams": "Teams",
        "users": "Usuarios",
        "ws_proxies": "Proxies WebSocket",
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