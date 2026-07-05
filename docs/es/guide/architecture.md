# Arquitectura

MCP REST Bridge se sitúa entre clientes MCP y tus backends. Mantiene un registro dinámico
de clientes y sus tools, anuncia una lista unificada de tools a los clientes MCP, y redirige
cada llamada al backend correcto a través de un pipeline de guards único y uniforme.

## El camino de la request

<RequestPath />

Cada política se aplica en el **punto de dispatch** (`proxyToolCall`), nunca como middleware
HTTP — MCP multiplexa muchas tools por una única ruta `POST /mcp`, así que el bridge debe
saber _qué_ tool se está llamando antes de poder aplicar reglas por herramienta.

## Cuatro formas de servir tools

| Modo                  | Endpoint                      | Qué expone                                        |
| --------------------- | ----------------------------- | ------------------------------------------------- |
| **Agregado**          | `POST /mcp`                   | Cada tool habilitada de cada cliente habilitado   |
| **Shard por cliente** | `/mcp/:clientName`            | Solo las tools de un cliente                      |
| **Bundle curado**     | `/mcp-custom/:bundleName`     | Un subconjunto entre clientes seleccionado a mano |
| **SSE legacy**        | `GET /sse` + `POST /messages` | Las mismas tools para clientes MCP antiguos       |

Los bundles son un filtro puramente de narrowing aplicado _antes_ del dispatch — todos los
guards, breakers y chequeos SSRF se comportan idénticamente sin importar por qué modo
llegó la llamada.

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

Siguiente: **[Seguridad →](/es/guide/security)** ·
**[Despliegue →](/es/guide/deployment)**
