# Referencia de API

El bridge expone unas pocas superficies HTTP distintas. El backend también sirve un
**explorador OpenAPI interactivo en `/docs`** (Swagger UI, generado desde `src/openapi.yaml`)
— abierto en desarrollo, detrás de auth admin en producción.

## Endpoints MCP (para callers de tools)

Donde se conectan los clientes MCP. Auth: `MCP_API_KEYS` Bearer, o un JWT cuando
`JWT_JWKS_URL` está configurado.

| Endpoint                           | Propósito                                       |
| ---------------------------------- | ----------------------------------------------- |
| `POST /mcp`                        | Streamable HTTP agregado — cada tool habilitada |
| `GET/POST /mcp/:clientName`        | Tools de un solo backend (shardeado)            |
| `GET/POST /mcp-custom/:bundleName` | Un bundle curado                                |
| `GET /sse` + `POST /messages`      | Transporte SSE legacy                           |

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

| Grupo           | Ejemplos                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `POST /admin-api/auth/login`, `/logout`, `GET /auth/me`                                                                                              |
| Servers & tools | `GET/POST /admin-api/clients`, `GET/PATCH/DELETE /admin-api/clients/:name`, `PATCH /admin-api/clients` (bulk enable/disable), `GET /admin-api/tools` |
| Curation        | `/admin-api/bundles*`, `/composites*`                                                                                                                |
| Access          | `/admin-api/mcp-keys*`, `/consumers*`, `/policies*`, `/users*`, `/teams*`                                                                            |
| Observability   | `/admin-api/overview`, `/usage/*`, `/alerts*`, `/audit-log*`                                                                                         |
| Config & ops    | `/admin-api/config/*` (export/import, snapshots, rollback), `/schedules*`, `/discovery/preview`                                                      |

Las formas completas request/response están en el Swagger UI en **`/docs`**.

## Operaciones

| Endpoint       | Auth                            | Propósito                                                                        |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `GET /health`  | ninguna                         | Liveness probe (`{ "status": "ok", "uptime_seconds": <n> }`) para load balancers |
| `GET /metrics` | sesión admin o `ADMIN_API_KEYS` | Métricas Prometheus (incl. `mcp_tool_calls_total{outcome}`)                      |
| `GET /admin`   | login de UI                     | El SPA Vue de admin                                                              |
| `GET /docs`    | dev-open / admin                | Explorador OpenAPI interactivo (Swagger UI)                                      |

## Errores

Los errores son JSON: `{ "error": { "code", "message", "request_id" } }`. El `request_id`
vincula un fallo al log estructurado del servidor — cítalo al reportar issues.

Siguiente: **[Conceptos y glosario →](/es/guide/concepts)** · **[Configuración →](/es/guide/configuration)**
