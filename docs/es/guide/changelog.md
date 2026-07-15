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
gestión de foco, strings de error traducidos). Consulta el
[`CHANGELOG.md`](https://github.com/aico-dot-team-code/mcpbridge/blob/main/CHANGELOG.md#unreleased)
raíz para la lista curada completa.

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
