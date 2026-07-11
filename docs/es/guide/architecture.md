# Arquitectura

MCP REST Bridge se sitúa entre clientes MCP y tus backends. Mantiene un registro dinámico
de clientes y sus tools, anuncia una lista unificada de tools a los clientes MCP, y redirige
cada llamada al backend correcto a través de un pipeline de guards único y uniforme.

## El camino de la request

<RequestPath />

Cada política se aplica en el **punto de dispatch** (`proxyToolCall`), nunca como middleware
HTTP — MCP multiplexa muchas tools por una única ruta JSON-RPC por scope, así que el bridge
debe saber _qué_ tool se está llamando antes de poder aplicar reglas por herramienta.

## Dos planos, tres endpoints

| Plano       | Endpoint                  | Qué expone                                                                        |
| ----------- | ------------------------- | --------------------------------------------------------------------------------- |
| **Control** | `POST /mcp`               | Gestión del gateway + obtención de datos (tools `sys_*`) — nunca tools de backend |
| **Datos**   | `/mcp/:clientName`        | Las tools de un solo cliente                                                      |
| **Datos**   | `/mcp-custom/:bundleName` | Un subconjunto entre clientes seleccionado a mano (tools y/o macros compuestas)   |

`/mcp` ya no es una vista aplanada de todas las tools de backend — ese modo "agregado"
redundante se eliminó. Si necesitas tools de backend cross-cliente en una sola sesión, cura
un bundle. `/mcp` es el plano de control: un cliente LLM se conecta ahí para inspeccionar y
operar el gateway (listar/registrar/habilitar clientes, emitir keys, leer el audit log, ...),
protegido por su propia auth fail-closed (`RootMcpAuth` — sin el fallback "sin configurar
implica abierto" que sí tienen los dos endpoints de datos) y un nivel de rol por tool
(read/operate/admin) más confirmación explícita para acciones sensibles. Ver
`src/mcp/system-tools.ts`.

La selección de tools/composites de un bundle es un filtro puramente de narrowing aplicado
_antes_ del dispatch — todos los guards, breakers y chequeos SSRF se comportan idénticamente
sin importar por qué endpoint de datos llegó la llamada. El transporte SSE legacy
(`GET /sse` y `POST /messages`) se eliminó junto con la agregación; Streamable HTTP es ahora
el único transporte MCP entrante.

## Dos tipos de backend

- **Clientes REST** — registrados desde un spec OpenAPI/Swagger (auto-descubrimiento) o
  una lista manual de tools. Cada tool mapea a un método + path HTTP sobre la URL base
  del backend.
- **Upstreams MCP** — servidores MCP existentes (Streamable HTTP o SSE) registrados como
  `kind: "mcp"`. El bridge se conecta hacia fuera, descubre sus tools y las re-expone.

Ambos se identifican por la misma identidad abstracta `client__tool`, así que toda
funcionalidad de governance — guards, guardrails, RBAC, bundles, uso, auditoría — se
aplica a ambos sin cambios.

## Almacenamiento y runtime

- **Runtime:** un único proceso [Bun](https://bun.sh) (Express 5 + `@modelcontextprotocol/sdk`).
- **Persistencia:** `bun:sqlite` — un fichero, sin base de datos externa, sin ORM. La
  config de admin (enable flags, guards, bundles, keys, audit, users, teams) vive aquí;
  el registro en vivo se hidrata desde ella al arrancar.
- **UI de admin:** un SPA Vue 3 + Vite separado, servido en `/admin`, hablando con la
  API admin JSON en `/admin-api/*`.

## Salud y resiliencia

Un loop en background chequea la salud de cada cliente y auto-elimina los no saludables
(con un `ping` probe para upstreams MCP). Los **circuit breakers** por herramienta se
disparan ante fallos repetidos, y un **canary/failover** secundario opcional puede tomar
el relevo cuando se abre el breaker primario — sin cerrar falsamente el breaker primario.

Para el razonamiento detrás de estas decisiones, consulta los
**[Architecture Decision Records →](/architecture/decisions/0001-two-planes-three-endpoints)**
(en inglés) y los **[SLOs →](/es/architecture/slos)** de fiabilidad.

Siguiente: **[Seguridad →](/es/guide/security)** ·
**[Despliegue →](/es/guide/deployment)**
