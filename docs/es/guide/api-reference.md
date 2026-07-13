# Referencia de API

El bridge expone unas pocas superficies HTTP distintas. El backend también sirve un
**explorador OpenAPI interactivo en `/docs`** (Swagger UI, generado desde `src/openapi.yaml`)
— abierto en desarrollo, detrás de auth admin en producción.

## Endpoints MCP (para callers de tools)

Donde se conectan los clientes MCP. Auth: `MCP_API_KEYS` Bearer, o un JWT cuando
`JWT_JWKS_URL` está configurado.

| Endpoint                           | Propósito                                                             |
| ---------------------------------- | --------------------------------------------------------------------- |
| `GET/POST /mcp/:clientName`        | Plano de datos — tools de un solo backend (shardeado)                 |
| `GET/POST /mcp-custom/:bundleName` | Plano de datos — un [bundle](/es/guide/bundles) curado entre backends |
| `POST /mcp`                        | Control plane — tools `sys_*` de gestión del gateway, no de backend   |

Los tres hablan **Streamable HTTP**; el transporte SSE legacy (`/sse` + `/messages`) fue
eliminado. `/mcp` tiene su propia auth fail-closed (requiere un rol de sistema real — sin
fallback "sin configurar significa abierto").

## Control plane — tools `sys_*` de gestión del gateway

`POST /mcp` expone un catálogo fijo de tools de gestión del gateway — adaptadores MCP finos
sobre la misma lógica de dominio que ya expone la admin API REST (`/admin-api/*`). Operan sobre
el gateway mismo (registrar e inspeccionar backends, activar/desactivar clients y tools, mintear
keys, hacer tail del audit log), **nunca** sobre tools de backend. Cada tool se gatea en dos
ejes, ambos aplicados en `runSystemTool()` (`src/mcp/system-tools.ts`):

- **Tier de rol** — replica los tiers del middleware REST. `read` requiere cualquier rol de
  sistema resuelto, `operate` requiere operator o admin, `admin` requiere admin. El rol del
  caller viene de `resolveSystemRole()` (el Bearer admin del entorno, o una fila `mcp_api_keys`
  gestionada con un `adminRole`). Las tools por encima del tier del caller se ocultan de
  `tools/list`, no solo se rechazan.
- **Step-up** — las tools que mutan, destruyen o mintean credenciales requieren además
  `{"__confirm": true}` en los argumentos **o** una credencial elevada — el mismo gate que
  `proxyToolCall` aplica a las tools de backend sensibles.

| Tool                        | Tier    | Step-up                  | Descripción                                                                         |
| --------------------------- | ------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `sys_list_clients`          | read    | —                        | Lista backends registrados (REST o upstreams MCP) con estado enable/salud.          |
| `sys_get_client`            | read    | —                        | Detalle completo de un backend, incluyendo sus tools y salud.                       |
| `sys_list_tools`            | read    | —                        | Cada par `(backend, tool)` de todos los backends registrados.                       |
| `sys_list_bundles`          | read    | —                        | Lista bundles curados por admin servidos en `/mcp-custom/:bundleName`.              |
| `sys_list_keys`             | read    | —                        | API keys MCP gestionadas — solo metadata; el valor de la key nunca es recuperable.  |
| `sys_metrics`               | read    | —                        | Snapshot de métricas del gateway: uptime, sesiones, conteo de tool-calls, latencia. |
| `sys_audit_tail`            | read    | —                        | Tail del audit log de admin (entradas más recientes primero).                       |
| `sys_set_client_enabled`    | operate | —                        | Activa o desactiva un backend (sus tools quedan inalcanzables mientras esté off).   |
| `sys_set_tool_enabled`      | operate | —                        | Activa o desactiva una sola tool de un backend.                                     |
| `sys_reset_circuit_breaker` | operate | —                        | Fuerza el circuit breaker de un backend vivo de vuelta a `closed`.                  |
| `sys_register_client`       | operate | `__confirm` / elevada    | Registra un backend REST/OpenAPI, upstream MCP o GraphQL (validado contra SSRF).    |
| `sys_delete_client`         | operate | `__confirm` / elevada    | Olvida permanentemente un backend y purga su config SQLite.                         |
| `sys_mint_key`              | admin   | Bearer env + `__confirm` | Mintea una API key MCP gestionada. Requiere el **Bearer admin del entorno**.        |
| `sys_revoke_key`            | admin   | `__confirm` / elevada    | Revoca una API key MCP gestionada por id.                                           |

`sys_mint_key` es la única tool que requiere el **Bearer admin del entorno** literal — ninguna
key gestionada, por privilegiada que sea, puede mintear otra (sin auto-escalada).

## Registro

Registra o re-descubre backends. Auth: sesión admin **o** `ADMIN_API_KEYS` Bearer.

| Endpoint               | Propósito                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /register`       | Registra un backend REST (`openapi_url`, `tools`, `curl_input`, o `postman_collection`), un upstream MCP (`kind: "mcp"`, `mcp_url`), o una API GraphQL (`kind: "graphql"`, `graphql_url`) |
| `GET /register/schema` | JSON Schema para el payload de registro                                                                                                                                                   |

Consulta [Registrar backends](/es/guide/registering-backends) para los campos del payload.

## Admin API — `/admin-api/*`

La API JSON de gestión detrás de la UI de admin Vue. Auth: cookie de sesión (con CSRF en
mutaciones) **o** `ADMIN_API_KEYS` Bearer. Role-gated; cada mutación se audita.

| Grupo           | Ejemplos                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `POST /admin-api/auth/login`, `/logout`, `GET /admin-api/auth/me`                                                                                                            |
| Servers & tools | `GET /admin-api/clients` (crear vía `POST /register`), `GET/PATCH/DELETE /admin-api/clients/:name`, `PATCH /admin-api/clients` (bulk enable/disable), `GET /admin-api/tools` |
| Curation        | `/admin-api/bundles*`, `/composites*`                                                                                                                                        |
| Access          | `/admin-api/mcp-keys*`, `/consumers*`, `/policies*`, `/users*`, `/teams*`                                                                                                    |
| Observability   | `/admin-api/overview`, `/usage/*`, `/alerts*`, `/audit-log*`                                                                                                                 |
| Config & ops    | `/admin-api/config/*` (export/import, snapshots, rollback), `/schedules*`, `/discovery/preview`                                                                              |

Las formas completas request/response están en el Swagger UI en **`/docs`**.

## Operaciones

| Endpoint       | Auth                            | Propósito                                                                                                      |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`  | ninguna                         | Salud genérica + uptime (`{ "status": "ok", "uptime_seconds": <n> }`) para load balancers y dashboards de ops  |
| `GET /livez`   | ninguna                         | Liveness probe de Kubernetes — siempre `200` mientras el proceso responda HTTP                                 |
| `GET /readyz`  | ninguna                         | Readiness probe de Kubernetes — `200` solo si tiene el lease de líder y la BD responde `SELECT 1`, si no `503` |
| `GET /metrics` | sesión admin o `ADMIN_API_KEYS` | Métricas Prometheus (incl. `mcp_tool_calls_total{outcome}`)                                                    |
| `GET /admin`   | login de UI                     | El SPA Vue de admin                                                                                            |
| `GET /docs`    | dev-open / admin                | Explorador OpenAPI interactivo (Swagger UI)                                                                    |

## Errores

Los errores son JSON: `{ "error": { "code", "message", "request_id" } }`. El `request_id`
vincula un fallo al log estructurado del servidor — cítalo al reportar issues.

Siguiente: **[Conceptos y glosario →](/es/guide/concepts)** · **[Configuración →](/es/guide/configuration)**
