---
description: Las superficies HTTP del gateway — la API JSON /admin-api, los planos MCP de control y de datos, los endpoints de salud y métricas, y el explorador Swagger en /docs.
---

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
keys, hacer tail del audit log), **nunca** sobre tools de backend. Cada tool se gatea en tres
ejes, todos aplicados en `runSystemTool()` (`src/mcp/system-tools.ts`) y no en cada handler:

- **Tier de rol** — replica los tiers del middleware REST. `read` requiere cualquier rol de
  sistema resuelto, `operate` requiere operator o admin, `admin` requiere admin. El rol del
  caller viene de `resolveSystemRole()` (el Bearer admin del entorno, o una fila `mcp_api_keys`
  gestionada con un `adminRole`). Las tools por encima del tier del caller se ocultan de
  `tools/list`, no solo se rechazan.
- **Step-up** — las tools que mutan, destruyen o mintean credenciales requieren además
  `{"__confirm": true}` en los argumentos **o** una credencial elevada — el mismo gate que
  `proxyToolCall` aplica a las tools de backend sensibles.
- **Scope de la key** — si los argumentos de una tool nombran un backend o un par
  `(backend, tool)`, se comprueban contra los `scopes` de la propia key que llama. Un objetivo
  fuera de ese scope recibe la respuesta de «no encontrado» habitual de la tool, así que «fuera de
  tu scope» y «no existe» son indistinguibles.

| Tool                        | Tier    | Step-up                  | Descripción                                                                         |
| --------------------------- | ------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `sys_list_clients`          | read    | —                        | Lista backends registrados (REST o upstreams MCP) con estado enable/salud.          |
| `sys_get_client`            | read    | —                        | Detalle completo de un backend, incluyendo sus tools y salud.                       |
| `sys_list_tools`            | read    | —                        | Cada par `(backend, tool)` de todos los backends registrados.                       |
| `sys_list_bundles`          | read    | —                        | Lista bundles curados por admin servidos en `/mcp-custom/:bundleName`.              |
| `sys_list_keys`             | read    | —                        | API keys MCP gestionadas — solo metadata; el valor de la key nunca es recuperable.  |
| `sys_metrics`               | read    | —                        | Snapshot de métricas del gateway: uptime, sesiones, conteo de tool-calls, latencia. |
| `sys_audit_tail`            | read    | —                        | Tail del audit log de admin (entradas más recientes primero).                       |
| `sys_diagnose`              | operate | —                        | Por qué se está rechazando una tool — ver la nota de abajo. Solo lectura.           |
| `sys_set_client_enabled`    | operate | —                        | Activa o desactiva un backend (sus tools quedan inalcanzables mientras esté off).   |
| `sys_set_tool_enabled`      | operate | —                        | Activa o desactiva una sola tool de un backend.                                     |
| `sys_set_guard`             | operate | —                        | Fija o borra la política de guardas de una tool: rate limit, timeout, allowlist.    |
| `sys_reset_circuit_breaker` | operate | —                        | Fuerza el circuit breaker de un backend vivo de vuelta a `closed`.                  |
| `sys_register_client`       | operate | `__confirm` / elevada    | Registra un backend REST/OpenAPI, upstream MCP o GraphQL (validado contra SSRF).    |
| `sys_delete_client`         | operate | `__confirm` / elevada    | Olvida permanentemente un backend y purga su config SQLite.                         |
| `sys_create_bundle`         | admin   | `__confirm` / elevada    | Crea un bundle curado servido en `/mcp-custom/:bundleName` — ver la nota de abajo.  |
| `sys_mint_key`              | admin   | Bearer env + `__confirm` | Mintea una API key MCP gestionada. Requiere el **Bearer admin del entorno**.        |
| `sys_revoke_key`            | admin   | `__confirm` / elevada    | Revoca una API key MCP gestionada por id.                                           |

Tres decisiones de tier que sorprenden, y por qué son así:

- **`sys_diagnose` es `operate`, no `read`**, aunque solo lea. Su salida más útil es el resumen de
  códigos de rechazo de las últimas llamadas de la tool, y esos son los datos del explorador de
  tráfico: `GET /admin-api/traffic` está gateado a operator justo por lo mismo, así que bajarla a
  `read` entregaría los registros de rechazo por llamada a cualquier key de auditor o viewer y
  dejaría la tool desalineada con la ruta REST que sirve esas mismas filas. Reporta los valores de
  las guardas, la salud y el estado del circuit breaker del backend, y el flag de activación de la
  tool; los conteos de rechazos son una muestra acotada de los errores más recientes
  (`truncated: true` significa que hubo rechazos más antiguos dentro de la ventana que nunca se
  contaron, así que trata `sampled` como un mínimo y reduce `windowMs` para una cifra exacta). Del
  allowlist de keys por tool solo se informa si está en vigor: nunca se evalúa contra la
  credencial de quien llama.
- **`sys_set_guard` no pide step-up**, igual que los demás toggles de tier `operate`: una guarda se
  revierte con una llamada más, y se aplica a través del mismo registro de políticas que usa el
  `PATCH` por tool de la admin API, de modo que el export/import de config y el rollback de
  snapshots la siguen viendo. Pasa `guards: null` para borrar la política por completo; las keys
  del allowlist se hashean antes de guardarse.
- **`sys_create_bundle` es `admin` y pide step-up** porque crea una nueva superficie de servicio.
  No admite miembros composite (macros): el nombre de un composite no lleva backend, así que la
  autorización por key que aplica esta tool no podría acotarlo; para eso, usa la admin API.

`sys_mint_key` es la única tool que requiere el **Bearer admin del entorno** literal — ninguna
key gestionada, por privilegiada que sea, puede mintear otra (sin auto-escalada).

### Prompts del gateway (`prompts/list` en `/mcp`)

`POST /mcp` sirve además los prompts MCP **propios** del gateway, para que un host como Claude
Desktop o Cursor pueda ofrecerlos como slash-commands y que el asistente del usuario le guíe en la
configuración de este gateway. Son guía, no capacidad: cada paso que describe un prompt es una
llamada `sys_*` corriente que sigue pasando por los gates de arriba, así que servir uno nunca puede
ampliar lo que una credencial puede hacer. A diferencia de `tools/list`, **no** se filtran por rol
—el texto es estático y no contiene estado del gateway—, pero llegar a `prompts/list` sigue
exigiendo un rol de sistema resuelto.

| Prompt                  | Argumentos                               | Qué le guía al asistente                                                                                     |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `onboard-a-backend`     | `source` (opcional), `kind` (opcional)   | Registrar una API o servidor MCP, revisar las tools descubiertas, acotarlas y devolver una key con scope.    |
| `diagnose-tool-failure` | `tool` (**obligatorio**), `error` (opc.) | Deducir qué capa del pipeline rechaza una tool y explicar el rechazo, y el arreglo, en lenguaje llano.       |
| `harden-this-client`    | `client` (**obligatorio**)               | Revisar tools activas, guardas, límites y scope de las keys de un backend, y proponer una config más segura. |

Los valores de los argumentos se interpolan en el texto renderizado, así que se validan con
severidad: un nombre de argumento no declarado es un error en lugar de ignorarse, falta un
obligatorio es un error, los valores se limitan a 512 caracteres y los caracteres de control se
convierten en espacios para que un valor no pueda falsificar líneas de instrucciones adicionales
con la voz del gateway.

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

| Endpoint        | Auth                            | Propósito                                                                                                      |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`   | ninguna                         | Salud genérica + uptime (`{ "status": "ok", "uptime_seconds": <n> }`) para load balancers y dashboards de ops  |
| `GET /livez`    | ninguna                         | Liveness probe de Kubernetes — siempre `200` mientras el proceso responda HTTP                                 |
| `GET /readyz`   | ninguna                         | Readiness probe de Kubernetes — `200` solo si tiene el lease de líder y la BD responde `SELECT 1`, si no `503` |
| `GET /metrics`  | sesión admin o `ADMIN_API_KEYS` | Métricas Prometheus (incl. `mcp_tool_calls_total{outcome}`)                                                    |
| `GET /admin`    | login de UI                     | El SPA Vue de admin                                                                                            |
| `GET /docs`     | dev-open / admin                | Explorador OpenAPI interactivo (Swagger UI)                                                                    |
| `GET /llms.txt` | ninguna                         | Autodescripción legible por máquinas para un agente que solo tiene la URL — ver abajo                          |

### `GET /llms.txt`

Sigue la convención [llms.txt](https://llmstxt.org/): `text/plain`, público y sin autenticar, para
que un agente que solo tiene la URL de este gateway pueda averiguar con qué está hablando y cómo
conectarse. Describe la **forma** de la API — qué endpoints existen, para qué sirve cada uno, cómo
autenticarse, y una entrada de cliente MCP lista para pegar — y a propósito **no** nombra ningún
backend, tool ni bundle registrado. No revela nada específico de la instancia: el cuerpo es una
constante más un único valor interpolado, la URL base, así que dos llamadas al mismo despliegue
devuelven documentos idénticos byte a byte. El inventario se queda detrás de una key, donde
`tools/list` es de todas formas la fuente autoritativa.

La URL base que anuncia es `GATEWAY_PUBLIC_URL` si está definida (se toma tal cual, para que
sobreviva un prefijo de ruta) y, si no, el esquema de la propia request más un `Host` reducido a un
origin desnudo por el parser de URL. El esquema es el de Express, que tiene en cuenta
`X-Forwarded-Proto` solo cuando `TRUST_PROXY` acepta al peer — así que un gateway cuyo TLS termina
más arriba y sin `TRUST_PROXY` anuncia `http`. **Define `GATEWAY_PUBLIC_URL`** y tanto este
documento como todos los snippets de conexión generados anunciarán la dirección correcta. La ruta
tiene su propio presupuesto de rate limit por IP, separado del de los install links, para que un
crawler que la descargue no pueda dejar a un compañero fuera de `/install/:token`.

## Errores

Los errores son JSON: `{ "error": { "code", "message", "request_id" } }`. El `request_id`
vincula un fallo al log estructurado del servidor — cítalo al reportar issues.

Siguiente: **[Conceptos y glosario →](/es/guide/concepts)** · **[Configuración →](/es/guide/configuration)**
