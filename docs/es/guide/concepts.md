# Conceptos y glosario

Esta página explica el vocabulario que usa el resto de la documentación — los términos que
puedes ver en la UI de administración, en la CLI y en los mensajes de log.

## Gateway, bridge, upstream

**Gateway / Bridge** — Sinónimos dentro de este proyecto. El proceso Bun que recibe llamadas
MCP, las valida y las envía a tus backends. Lo verás referido como "the bridge" en la mayor
parte de la documentación.

**Upstream** — Un servidor backend que el bridge re-expone como herramientas MCP.
Puede ser una API REST registrada desde un spec OpenAPI, o un servidor MCP existente
(Streamable HTTP o SSE).

## Cliente, consumidor y key

**Cliente (MCP)** — El agente o IDE del lado del consumidor (Claude Desktop, Cursor, un
SDK personalizado) que abre una sesión MCP contra el bridge.

**API key (o Bearer token)** — Credencial que un cliente presenta al bridge para
autenticarse. Se crea en **API keys**, vive en el backend, y está restringida por scopes
(qué clientes/herramientas puede llamar).

**Consumidor** — Una entidad lógica (humana o de sistema) a la que pertenece una API key. Las
keys se acotan a un consumidor para que puedas aplicar cuotas y hacer un seguimiento del
uso por cliente/equipo.

## Tool, bundle, composite

**Tool** — Una función invocable expuesta vía MCP. Cada operación REST descubierta de un
spec OpenAPI se convierte en una tool; cada tool registrada en un upstream MCP pasa tal
cual.

**Bundle** — Un conjunto curado, entre backends, de tools servidas en un endpoint
`/mcp-custom/<bundle>`. Cuando un cliente MCP apunta a un bundle, solo ve las tools que
seleccionaste — útil para "esta app solo necesita estas X tools".

**Composite** — Una tool de orden superior que ejecuta varias tools en cadena y devuelve
un resultado agregado. Ejemplo: `summarize_issue` que llama a `get_issue`, `list_comments`
y `post_summary` en secuencia.

## Guardrails y políticas

**Guardrail / guard** — Una regla configurable aplicada a una tool específica o al
comportamiento global. Tipos:

- **Guardrails & resilience** — denegación de patrones de prompt-injection, red de
  seguridad de secretos, normalización de inputs.
- **Rate limit / timeout / circuit breaker** — Governance operacional.
- **Allowed keys** — restringir qué API keys pueden llamar a una tool específica (más
  estricto que el scope).

**Canary / failover** — Un servidor secundario opcional que el bridge usa cuando el
primario tiene el circuito abierto. No engaña al breaker primario: solo asume el tráfico
en respuesta a una condición de breaker abierto.

## Modos de servir

**Control `/mcp`** — El plano de control del propio gateway: tools `sys_*` de gestión y
obtención de datos (listar/registrar/habilitar clientes, emitir keys, audit log...). Nunca
sirve tools de backend — para eso están los dos modos de datos de abajo. Auth fail-closed
(`RootMcpAuth`, sin el fallback "sin configurar implica abierto") + nivel de rol por tool.

**Sharded `/mcp/:clientName`** — Una endpoint por upstream backend — útil para aislar
clientes o limitar blast radius.

**Curated `/mcp-custom/:bundleName`** — Una endpoint por bundle — herramientas (y/o
composites) seleccionadas a mano, expuestas a un cliente.

El modo "Aggregated" (todas las tools de todos los backends aplanadas en `/mcp`) y el
transporte SSE legacy (`GET /sse` + `POST /messages`) fueron eliminados: `/mcp` es ahora
el plano de control, y Streamable HTTP es el único transporte MCP entrante.

## Audit, RBAC, equipos

**Audit log** — Registro append-only, encadenado por hash, de cada acción de
administración (crear server, rotar key, editar guard, etc.). Está firmado de modo que
modificar una entrada invalida todas las posteriores.

**RBAC** — Control de acceso basado en roles. El bridge soporta cuatro: `admin`,
`operator`, `auditor`, `viewer`.

**Team** — Un grupo al que pertenecen servidores y usuarios para multi-tenancy. Un
servidor asignado a un equipo solo es visible/administrable por miembros de ese equipo.

## SSRF y seguridad

**SSRF (Server-Side Request Forgery)** — Una vulnerabilidad donde un atacante hace que el
servidor emita requests contra hosts internos o metadatos de cloud. El bridge mitiga esto
con IP-pinning (resuelve DNS una vez a una IP, nunca la re-resuelve), validación de URL,
y bloqueo de rangos privados.

**IP-pinning** — Práctica de resolver el DNS de un backend una vez en el registro y
almacenar la IP para siempre. Cualquier request subsiguiente va a esa IP exacta, incluso
si el DNS cambia, lo que evita trucos DNS-rebinding.

**Prompt-injection guardrail** — Una regla de guard que busca patrones conocidos de
inyección en inputs de tools y los bloquea / sanitiza antes de llegar al backend.

## Conclusión

Si te encuentras con un término no explicado aquí, abre un issue — la documentación
crece con las contribuciones.
