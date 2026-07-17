# Changelog

Refleja el [`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md)
raíz del repo para que sea buscable junto al resto de las docs. El formato se basa en
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); este proyecto sigue
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Para el historial completo a
nivel de commit, consulta [GitHub Releases →](https://github.com/aico-dot-team-code/mcpbridge/releases).

## [Unreleased]

Desde la 1.0.0, el backend ha incorporado cobertura exhaustiva de mutation testing con Stryker
(todo archivo con lógica de runtime relevante está ahora efectivamente al 100% de mutantes
eliminados), además de varios cambios reales de cara al usuario/operador: propagación de contexto W3C `traceparent` a través del
pipeline del proxy, un [contrato público de SLOs](/es/architecture/slos) de fiabilidad, cobertura
e2e ampliada con Playwright integrada en CI, y una corrección de seguridad para que el log de
configuración de arranque ya no filtre `SECRET_ENCRYPTION_KEY`/`VAULT_TOKEN` en texto plano.

Después llegaron varias rondas de hardening de seguridad: una **rotura del build de la imagen
Docker (P0)** que impedía construir cualquier imagen del contenedor; un **escape de tenancy por
equipos** donde un admin con alcance de equipo podía llegar a rutas globales (CRUD de usuarios,
backup de la BD, export/import de config) reservadas a super-admins; una **guarda contra
prototype-pollution** en cada lector/escritor de dot-paths de tools, unificada en un único
`src/lib/object-path.ts` reforzado; el requisito de que la autenticación JWT entrante configure
**`JWT_AUDIENCE`**, cerrando un hueco de reuso de token entre audiencias; una **fuga permanente de
capacidad de sesiones MCP (DoS)** donde un POST sin sesión que no era un `initialize` nunca
liberaba su reserva; una **fuga de la sonda half-open del circuit breaker** que podía dejar
atascado para siempre un cliente en recuperación; sanitización de respuestas uniforme en los
caminos de éxito **y** error de REST/MCP-upstream/WebSocket; anclaje real de IP para las conexiones
WebSocket (el shim `ws` de Bun ignoraba silenciosamente la protección anti DNS-rebinding
existente); y un refetch de JWKS ante un `kid` desconocido para que una rotación normal de clave
del IdP ya no bloquee la autenticación JWT/SSO. A nivel operativo: los health probes de Helm/Docker
ahora apuntan a los endpoints propósito-específico `/livez` (liveness) y `/readyz` (readiness, con
leader-gating) en lugar del legacy `/health` (siempre 200); el CLI ganó `--help`/`--version` de
nivel superior; un directorio `examples/` listo para ejecutar aporta configs de muestra y cuerpos
de `/register` para cada modo de registro; `monitoring/` aporta reglas de alerta de Prometheus y un
dashboard de Grafana desplegables para los SLOs; y la admin UI recibió una compuerta de cobertura
tipo ratchet más una ronda de correcciones de accesibilidad (modelo de teclado ARIA para tabs,
gestión de foco, strings de error traducidos).

Más recientemente: una **corrección P0** cerró un bypass en `resources`/`prompts` de MCP donde una
clave gestionada restringida a un cliente aún podía leer los resources y prompts de otro cliente a
través de la ruta compartida `/mcp/:clientName` (ese contenido ahora también pasa por el escaneo de
guardrails y el credential-strip igual que los resultados de tools); una **corrección P1** amplió
la lista de bloqueo IPv4 para SSRF para cubrir varios rangos reservados que la ruta IPv6 ya
bloqueaba; y una **corrección P1** hizo que la caché del validador de schema compilado por tool se
invalide al re-registrar, de forma que endurecer el `inputSchema` de una tool ya no sigue aplicando
el schema anterior, más laxo, hasta un reinicio del proceso. Junto a eso: varias correcciones de
corrección en la admin UI (el botón `Prev` de paginación quedándose atascado antes de la página
uno, una columna mal etiquetada en AlertsPage, un bug de sincronización de filtro obsoleto con la
URL, una guarda de cambios sin guardar que faltaba), una corrección del CLI para que una respuesta
no-JSON de la admin API lance un `CliApiError` propio en vez de un error de parseo crudo, smoke
tests de CI que ahora arrancan de verdad la imagen Docker y los binarios de release antes de
publicarlos, y varias correcciones de documentación (guía de health-probes/balanceo de carga,
comportamiento de re-resolución del IP-pin, el rango del canary weight en OpenAPI).

Después de eso: una **corrección P0** cerró un escape de tenancy de admins con scope de equipo en
`POST /admin-api/policies/:id/apply` (una lista de tools/bundle enviada por el caller se aplicaba
sin ningún check de propiedad, dejando que un admin de equipo sobreescribiera la guard policy de
otro tenant), seguida de tres correcciones más de tenancy de la misma familia — CRUD de schedules
(P1), el listado de approvals filtrando argumentos de tool sin redactar entre tenants (P1), y el
listado de managed keys (P2) — más una feature real: un super-admin ahora puede otorgar o editar
el **rol de sistema** de una key gestionada directamente desde la página Keys de la admin UI, en
vez de necesitar una llamada `curl` cruda para emitir una key con acceso al control plane `/mcp`.
También: dos correcciones de accesibilidad en la admin UI (SelectMenu sin nombre accesible en las
páginas de detalle de servidor y de Policies), una corrección para que la advertencia de consola
por missing-key de i18n en la admin UI realmente se silencie, una corrección del CLI/admin-UI para
que `gateway connect --scope system` sugiera el tipo de key correcto, y correcciones en CLAUDE.md
(la salvedad del flag de retry para PUT/DELETE, el comando antes no documentado `bun run
test:mutate`, y la cobertura completa de los jobs de CI incluyendo `e2e`/CodeQL/`security.yml`).
Consulta el
[`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md#unreleased)
raíz para la lista curada completa.

Lo más reciente: el bridge ahora anuncia las **anotaciones de tools MCP (2025-06-18)** estándar —
`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` y un `title` de visualización,
derivados del método HTTP de una tool y de su gating de sensibilidad/aprobación — y pasa a través
fielmente el `title`/anotaciones propios que declara un upstream MCP (hints advisory que
complementan, nunca reemplazan, la aplicación en tiempo de llamada). La observabilidad ganó
**correlación de logs por `request_id`** (filtra un único request de principio a fin) y un gauge
constante **`mcp_build_info`** que fija la versión/runtime en ejecución. En el lado de las
correcciones: los parámetros descubiertos por OpenAPI ahora se enrutan a la parte del request que
declara su spec (`in: query`/`header`/`cookie`) en vez de caer por defecto en el query string o el
body; un backend GraphQL que falla tras un HTTP 200 (un `errors[]` de nivel superior con `data`
nula) ahora dispara su circuit breaker en vez de contar como éxito; y el bridge dejó de anunciar un
`outputSchema` upstream que no puede honrar (que hacía que el cliente oficial del SDK de MCP
rechazara cada llamada a esa tool). En seguridad: las lecturas de introspección se confinan al
tenant del caller, los pins SSRF IPv6 se ponen entre corchetes correctamente, la ruta de dispatch
WebSocket libera una sonda de breaker consumida, la credencial upstream inyectada se elimina de las
respuestas reflejadas sin importar el esquema de auth, el `title`/anotaciones upstream se sanitizan
contra prompt-injection, y un argumento de tool enrutado a un header o cookie no puede inyectar un
header prohibido ni sobreescribir un header de auth gestionado por el gateway.

## [1.0.0] - 2026-07-03

Primera release etiquetada de **MCP REST Bridge** — un gateway MCP self-hosted que
convierte APIs REST (vía auto-descubrimiento OpenAPI/Swagger) y servidores MCP existentes
en tools de IA seguras y gobernadas, con una admin UI Vue integrada en lugar de una pila
de YAML. Todo lo de abajo aterrizó incrementalmente en `main` y se publica en conjunto
como `1.0.0`.

### Aspectos destacados

- **Núcleo del gateway.** Auto-descubrimiento y registro de OpenAPI/Swagger a MCP, registro
  passthrough de MCP a MCP, endpoint MCP shardeado, y un sobre canónico de request/response
  en ambos transportes.
- **Seguridad por defecto.** Protección SSRF y DNS-rebinding con anclaje de la IP del
  upstream, allowlisting CORS estricto, comparaciones de sesión/auth hasheadas, secretos de
  upstream cifrados (`secret-box`), sanitización de prompt-injection, y guardas de
  rechazo-de-arranque ante configuración insegura (p. ej. `AUTH_DISABLED` fuera de dev, CORS
  wildcard).
- **Resiliencia.** Circuit breakers por cliente con fallos de ventana deslizante y sondas
  half-open atómicas, rate limiting por tool con buckets acotados por LRU, retry con señales
  de abort aisladas y manejo de `Retry-After` en formato HTTP-date, y polling de health
  resiliente con shutdown consciente del drain.
- **Observabilidad.** Exposición Prometheus para métricas de breaker/rate-limiter/proxy/health,
  tracing OTLP, un visor de trazas, detección de anomalías de uso, y un audit log con
  hash-chain a prueba de manipulación con streaming a SIEM.
- **Persistencia de admin y guards.** Config persistente respaldada por SQLite (`bun:sqlite`)
  para clientes, tools y guards, overrides de guard dinámicos por cliente/por tool, y
  versionado/rollback de config.
- **Admin UI.** Una admin UI completa en Vue 3 + Vite (dashboard, tráfico, monitores,
  aprobaciones, observabilidad, charts SVG reutilizables) que cubre registro, guardrails,
  RBAC, teams, schedules y canary/failover — reemplazando el YAML editado a mano.
- **Gobernanza y features enterprise.** RBAC, teams multi-tenant, aliases de tools,
  composites, un catálogo de tools buscable, un playground, aprobaciones multinivel,
  policy-as-code (YAML), alertas de schema-drift, y rate limits por usuario final.
- **Features de protocolo/proxy.** Descubrimiento GraphQL, passthrough WebSocket (incluyendo
  conexiones persistentes), soporte de progress/cancel de MCP, coalescing de requests,
  auto-cuarentena de upstreams que se portan mal, y un CLI para gestión scriptada.
- **Docs y sitio.** Un sitio de documentación y marketing basado en VitePress con un demo
  interactivo de la admin UI respaldado por mocks, publicado vía GitHub Pages.

Siguiente: **[Contribuir →](/es/guide/contributing)** · **[Política de seguridad →](/es/guide/security-policy)**
