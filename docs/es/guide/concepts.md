# Conceptos y glosario

Un recorrido rápido por el vocabulario que se usa en esta documentación y en la UI de admin.

## La idea central

El bridge mantiene un **registro** (registry) de backends y proxia cada llamada a través de una
única guard pipeline uniforme, direccionada por una identidad estable `client__tool` — consulta
**[Arquitectura →](/es/guide/architecture)** para el camino completo de la request. El glosario
de abajo cubre el vocabulario que aparece en la documentación y en la UI de admin.

## Glosario

| Término                         | Qué significa                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cliente** (backend)           | Un backend registrado — una API **REST** (tools descubiertas desde OpenAPI) o un **upstream MCP** (`kind: "mcp"`).                                                                                   |
| **Tool**                        | Una única operación invocable, con namespace `clientName__toolName`.                                                                                                                                 |
| **Modo de servir**              | Cómo un cliente alcanza tools de _backend_: **shard por cliente** (`/mcp/:name`) o **bundle curado** (`/mcp-custom/:bundle`). `/mcp` en sí es el plano de control, no un modo de servir — ver abajo. |
| **System tool**                 | Una tool `sys_*` sobre el propio gateway (gestión + obtención de datos), servida solo en la raíz del plano de control `/mcp` — nunca una tool de backend.                                            |
| **[Bundle](/es/guide/bundles)** | Un subconjunto curado por un admin, entre clientes, de tools (y/o macros composite) tras un endpoint — cómo pones varios backends tras una sola URL MCP.                                             |
| **Guard**                       | Una **política** por tool: rate limit, timeout, override de circuit-breaker, restricción de keys permitidas.                                                                                         |
| **Guardrail**                   | Un control de **contenido** por tool: deny-rules de input, detección de secretos, escaneo de prompt-injection en responses, redacción de campos.                                                     |
| **Circuit breaker**             | Protección de fallos por tool (`closed → open → half_open`) que falla rápido mientras un backend no está sano.                                                                                       |
| **Canary / failover**           | Enruta parte o todo el tráfico a un backend **secundario** validado (canary ponderado, o failover cuando el breaker primario se abre).                                                               |
| **Consumidor**                  | Un tenant/equipo/producto que agrupa API keys y lleva una **cuota** mensual.                                                                                                                         |
| **MCP API key**                 | La credencial que presenta un caller de tools; puede tener **scope** (a clientes/tools), ser **elevada** (para tools sensibles), expirar y revocarse. Almacenada como hash.                          |
| **Usuario / rol admin**         | Quién administra el bridge, gated por RBAC: `admin` / `operator` / `auditor` / `viewer`.                                                                                                             |
| **Equipo (team)**               | Una frontera de multi-tenancy que acota clientes para que los tenants solo vean los suyos.                                                                                                           |
| **Registry**                    | La vista viva en memoria de clientes + tools, hidratada desde SQLite y con monitorización de salud.                                                                                                  |
| **Audit log**                   | Un registro a prueba de manipulaciones, **encadenado por hash**, de cada mutación admin; opcionalmente streameado a un SIEM.                                                                         |
| **Leader**                      | La única instancia (elegida vía un lease en SQLite) que corre los loops en background — alertas, programaciones — en un despliegue multi-instancia.                                                  |
| **Tool composite**              | Una macro que ejecuta varios pasos de tool como una llamada, cada paso por la pila completa de guards.                                                                                               |
| **`search_tools`**              | Una meta-tool sintética que deja a un cliente buscar en su propia lista de tools.                                                                                                                    |

## Cómo encajan las piezas

- **Conecta** un backend → sus tools entran en el registry ([Registrar backends](/es/guide/registering-backends)).
- **Cura** lo que ve un cliente con modos de servir y [bundles](/es/guide/bundles).
- **Gobierna** cada tool con guards, guardrails y control de acceso.
- **Opera** con health checks, métricas, alertas, audit — y [escala](/es/guide/scaling) cuando lo necesites.

Consulta la **[Arquitectura →](/es/guide/architecture)** para el camino de la request, o la
**[Referencia de API →](/es/guide/api-reference)** para los endpoints.
