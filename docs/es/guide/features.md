# Funcionalidades

Todo lo que hace MCP REST Bridge, agrupado por lo que intentas lograr. Cada grupo enlaza a
la guía que lo cubre en profundidad.

## Conectar cualquier cosa

Consulta **[Registrar backends →](/es/guide/registering-backends)**.

- **OpenAPI / Swagger → auto-descubrimiento MCP.** Apunta a una URL de spec; cada operación
  se convierte en una herramienta MCP. Filtra con `include_tags` / `exclude_operations`.
- **GraphQL → auto-descubrimiento MCP.** Apunta a un endpoint GraphQL; el bridge
  introspecciona el schema y genera una herramienta por query/mutation.
- **Importación cURL / Postman.** Deriva herramientas de un comando `curl` pegado o de una
  exportación de Postman Collection v2.1 cuando no hay spec.
- **MCP → gateway / agregador MCP.** Registra servidores MCP existentes (Streamable HTTP o
  SSE) como upstreams y re-expón sus herramientas a través del mismo pipeline.
- **Definiciones manuales de tools** cuando un backend no tiene spec.
- **Dos modos de servir en el plano de datos** — por cliente `/mcp/:name` y bundles curados
  `/mcp-custom/:bundle` (que también pueden incluir macros compuestas). `/mcp` en sí es el
  plano de control (gestión del sistema + obtención de datos), no un tercer modo de servir
  datos — ver [Arquitectura](/es/guide/architecture).
- **Aliases y nombres visibles de tools** para presentar nombres limpios y amigables al cliente.
- **Tags de tools** — tags libres en cada cliente registrado, navegables y filtrables por
  tag desde la UI de admin.
- **Tools compuestas / macro** que ejecutan varios pasos como una llamada, cada paso a
  través de la pila completa de guards. No son alcanzables por defecto — hay que añadir la
  composite al `composites[]` de un bundle para servirla en el endpoint de ese bundle
  (`/mcp-custom/:bundle`).
- **Plano de control del sistema (`/mcp`)** — un cliente LLM se conecta aquí (no a un shard de
  backend) para administrar el propio gateway: listar/registrar/habilitar clientes, emitir o
  revocar keys MCP, leer el audit log, resetear un circuit breaker, y más. Auth fail-closed
  (sin el fallback "sin configurar implica abierto") más un nivel de rol por tool
  (read/operate/admin) y confirmación explícita para acciones sensibles. Ver
  [Arquitectura](/es/guide/architecture).
- **Backends GraphQL y WebSocket** (por tool) — envuelve los argumentos de una llamada como
  request GraphQL `{ query, variables }`, o haz un request/response efímero sobre WebSocket,
  reutilizando la misma pila de guards que REST.
- **Targets dedicados de proxy WebSocket** — registra un endpoint WS backend persistente
  (con límites de connections, message-size y idle-timeout), y desconecta forzosamente en masa
  cada conexión activa.
- **Recursos y prompts upstream** — un endpoint `/mcp/:name` por cliente apuntado a un servidor
  MCP ahora pasa a través de sus recursos y prompts, no solo de sus tools.
- **Anotaciones de tools MCP (2025-06-18)** — cada tool anunciada lleva los hints estándar de
  gobernanza/presentación (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` y
  un `title` de visualización), derivados de su método HTTP y de su gating de
  sensibilidad/aprobación; el `title` y las anotaciones propias que declara un upstream MCP se
  pasan a través fielmente. Son hints **advisory** que un cliente puede usar para presentar o
  pre-gatear una tool — complementan, nunca reemplazan, la aplicación en tiempo de llamada del
  gateway.
- **Enlaces de instalación de bundles** — un enlace compartible y revocable de un clic que
  crea una API key MCP con scope de bundle y resuelve a un snippet de conexión listo para
  pegar, para que los usuarios finales nunca necesiten una key provisionada a mano.

## Gobernar y asegurar

Consulta **[Seguridad →](/es/guide/security)**, **[Guardrails y resiliencia →](/es/guide/guardrails-resilience)**
y **[Control de acceso →](/es/guide/access-control)**.

**Seguridad de red y contenido**

- **Protección SSRF + DNS-rebinding** en cada URL de backend, con la IP resuelta anclada
  para que un cambio posterior de DNS no pueda redirigir el tráfico.
- **Guardrails** — reglas de denegación de inputs, detección de secretos y sanitización de
  prompt-injection que envuelve las responses no confiadas en un sobre seguro.
- **Política por herramienta** — rate limits, timeouts, overrides de circuit-breaker y
  restricciones de API keys permitidas, aplicadas en el dispatch antes del circuit breaker.

**Acceso e identidad**

- **RBAC** con roles `admin` / `operator` / `auditor` / `viewer`.
- **Multi-tenancy por equipos** — acota clientes a equipos para que cada tenant solo vea los suyos.
- **Login de admin por sesión** (argon2id vía `Bun.password`) más un camino de key Bearer
  estática para CI/automatización, con protección CSRF en las mutaciones autenticadas por cookie.
- **OAuth2 / JWT entrante** (opcional) — acepta tokens de acceso OAuth2/OIDC (RS256/ES256)
  verificados contra un endpoint JWKS, junto a las keys estáticas y gestionadas en DB. Sin
  dependencia extra (WebCrypto).
- **OAuth2 client-credentials saliente** — el bridge emite y auto-refresca un token desde el
  endpoint de token del backend y lo inyecta, para que el caller MCP nunca vea el client secret real.

**Control y flujo**

- **Aprobación humana en el bucle** — las tools de alto riesgo pueden requerir una aprobación
  admin fuera de banda; la llamada abre un ticket ligado a sus argumentos exactos y es de un
  solo uso una vez aprobada.
- **Transforms declarativos de request/response** — remodela los argumentos o la response JSON
  de una tool (set / remove / rename / copy) sin código y sin eval de expresiones que explotar.

## Operar con confianza

**UI de admin y config**

- **UI de admin (Vue 3 SPA)** — dashboard, servidores, bundles, API keys, consumidores,
  políticas, uso, alertas, programaciones, audit log, usuarios, equipos y config.
- **Dashboard de widgets personalizable** — una grid de Overview estilo Grafana: añade,
  redimensiona y configura widgets de stat/chart/nota desde un catálogo, y exporta o importa
  el layout entero.
- **Versionado de config + rollback**, más import/export de toda la configuración.
- **Programaciones de mantenimiento** vía un matcher cron integrado (gated por leader, deduplicado).

**Resiliencia** — ver **[Guardrails y resiliencia →](/es/guide/guardrails-resilience)**

- **Monitorización de salud + auto-eliminación** de backends no saludables, con un probe ping
  para upstreams MCP.
- **Canary / failover** — enruta a un secundario validado cuando el breaker del primario se
  abre, sin cerrar falsamente el breaker del primario.
- **Caché de responses** — TTL por tool + caché LRU para responses `GET` idempotentes, servida
  tras todos los guards pero antes del circuit breaker (un hit de caché nunca gasta un probe half-open).
- **Balanceo de carga N-way** — reparte las llamadas de un cliente entre un pool de targets
  upstream (round-robin / ponderado / least-connections) con un cooldown de salud por target,
  encima del circuit breaker primario.

**Manejo de datos**

- **Auto-paginación** — sigue paginación cursor / page / `Link` RFC-5988 y agrega las páginas
  en una sola response (solo mismo host, SSRF-safe).
- **Normalización de streaming** — convierte una response NDJSON o SSE en un único resultado JSON agregado.
- **Mock / virtualización** — sirve una response predefinida (siempre, para desarrollo
  contract-first) o solo como fallback cuando el backend no está disponible.

## Observar

Consulta **[Observabilidad y monitorización →](/es/guide/observability)**.

- **Prometheus `/metrics`**, incluyendo `mcp_tool_calls_total{outcome}`.
- **Tracing OpenTelemetry (OTLP/HTTP)** — un span por llamada de tool cuando hay un endpoint OTLP.
- **Analítica de uso** y **detección de anomalías / picos de uso** que dispara alertas vía webhooks.
- **Audit log a prueba de manipulaciones** — cada acción admin está encadenada por hash
  (`hash = SHA256(JSON.stringify([prev_hash, …]))`, una pre-imagen JSON inyectiva, no una unión
  por delimitador) y es verificable; opcionalmente streameada a un SIEM.
- **Explorador de tráfico + replay** — captura opt-in por llamada (argumentos + un preview del
  resultado) que puedes inspeccionar y re-ejecutar desde la admin API.
- **Monitorización sintética + schema-drift** — reproduce periódicamente un ejemplo guardado a
  través de una tool y marca fallos, y detecta cuándo el schema de input de un upstream deriva
  de una baseline capturada.

## Escalar (opt-in)

Consulta **[Escalado y alta disponibilidad →](/es/guide/scaling)**.

- **Contadores de rate compartidos** en SQLite para límites consistentes entre instancias.
- **Reconciliación del registro cross-instancia** para que registros y bajas propaguen a los peers.
- **Elección de leader** para que los loops en background (alertas, programaciones) corran en
  exactamente una instancia.

## Ejecuta en cualquier sitio

Proceso único Bun + `bun:sqlite` — sin base de datos externa, sin Kubernetes. Consulta
**[Despliegue →](/es/guide/deployment)** para Docker, bare-metal y reverse-proxy.

Siguiente: **[Primeros pasos →](/es/guide/getting-started)** ·
**[Por qué MCP REST Bridge →](/es/guide/why-mcp-rest-bridge)**
