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
- **Cuatro modos de servir** — agregado `/mcp`, por cliente `/mcp/:name`, bundles curados
  `/mcp-custom/:bundle`, y SSE legacy `/sse`.
- **Aliases y nombres visibles de tools** para presentar nombres limpios y amigables al cliente.
- **Tags de tools** — tags libres en cada cliente registrado, navegables y filtrables por
  tag desde la UI de admin.
- **Tools compuestas / macro** que ejecutan varios pasos como una llamada, cada paso a
  través de la pila completa de guards.
- **Backends GraphQL y WebSocket** (por tool) — envuelve los argumentos de una llamada como
  request GraphQL `{ query, variables }`, o haz un request/response efímero sobre WebSocket,
  reutilizando la misma pila de guards que REST.
- **Targets dedicados de proxy WebSocket** — registra un endpoint WS backend persistente
  (con límites de connections, message-size y idle-timeout), y desconecta forzosamente en masa
  cada conexión activa.
- **Recursos y prompts upstream** — un endpoint `/mcp/:name` por cliente apuntado a un servidor
  MCP ahora pasa a través de sus recursos y prompts, no solo de sus tools.
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

(Esta página es una traducción al español; consulta la versión inglesa para el contenido
completo.)
