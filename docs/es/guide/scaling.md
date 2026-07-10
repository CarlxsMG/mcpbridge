# Escalado y alta disponibilidad

MCP REST Bridge corre feliz como un único proceso — una instancia Bun con un fichero
SQLite local maneja mucho. Cuando necesitas redundancia o más throughput, escala
horizontalmente: ejecuta varias instancias idénticas tras un load balancer, coordinadas
a través de una base de datos SQLite compartida.

## El modelo

- **Manejo de requests stateless.** Cada llamada de tool es autocontenida; cualquier
  instancia puede servir cualquier llamada REST.
- **SQLite es la capa de coordinación.** Config admin, guards, keys, audit, uso y las
  primitivas HA viven todas en la base de datos. Apunta cada instancia al **mismo**
  `DB_PATH` (almacenamiento compartido / un volumen compartido) para que vean una sola
  config.
- **Flags de HA opt-in** activan comportamiento cross-instancia (abajo) — están off por
  defecto para que un único nodo se mantenga simple.

<ScaleOut />

## Activar las primitivas HA

| Setting                  | Efecto                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_SHARED=true` | Los rate limits usan contadores fixed-window en SQLite, de modo que un límite por tool se aplica cross-**all**-instancias, no por proceso.         |
| `REGISTRY_SYNC=true`     | Cada instancia reconcilia periódicamente su registry en vivo desde SQLite — un cliente registrado (o eliminado) en un nodo se propaga a los otros. |

Los loops en background que deben correr **una vez** — evaluación de alertas, schedules de
mantenimiento y el loop de health-check/auto-eliminación — eligen un único líder
automáticamente vía un lease en SQLite. Esto no es una flag; siempre está activo y no
requiere configuración.

## Load balancing de tus backends

Separado de escalar el bridge mismo, un único **cliente** puede fan-out entre **varios
targets de backend** (load balancing N-way), configurado por cliente desde la admin API.
Un target que falla se salta durante `LB_TARGET_COOLDOWN_MS` (por defecto 30s) antes de
probarlo de nuevo. Combina con **canary/failover** por cliente (consulta [Guardrails y
resiliencia](/es/guide/guardrails-resilience)) para degradación con gracia.

## Sesiones MCP y sticky routing

El transporte **Streamable HTTP** mantiene estado por sesión **en memoria** en la instancia
que abrió la sesión. Dos opciones:

- **Sticky sessions** — habilita afinidad de sesión en tu load balancer para los endpoints
  MCP (`/mcp`, `/mcp/:name`, `/mcp-custom/:bundle`) para que una sesión se quede en una
  instancia. Recomendado para clientes streaming.
- **Llamadas stateless** — los clientes que abren un request fresco por llamada no
  necesitan afinidad y se balancean libremente.

El proxy REST y la admin API no necesitan afinidad.

## Caveats que debes conocer

- **SQLite compartido requiere almacenamiento compartido.** SQLite sobre un filesystem de
  red tiene quirks de locking; prefiere un volumen que todas las instancias monten
  localmente, o mantén las escrituras modestas. Para volumen de escritura muy alto,
  ejecuta menos instancias, más grandes.
- **La cadena de hash del audit es por instancia.** Su tamper-evidence (`verifyAuditChain`)
  asume un único escritor; la integridad de la cadena cross-instancia está fuera de scope
  — streamea a un SIEM (`AUDIT_SINK_URL`) para un registro consolidado y ordenado en su
  lugar.

## Checklist

- [ ] Todas las instancias comparten un `DB_PATH`
- [ ] `RATE_LIMIT_SHARED=true` y `REGISTRY_SYNC=true`
- [ ] El load balancer chequea `/health`
- [ ] Sticky sessions para los endpoints MCP `/mcp` · `/mcp/:name` · `/mcp-custom/:bundle` (si usas streaming)
- [ ] `AUDIT_SINK_URL` configurado para un audit trail consolidado

Consulta **[Despliegue →](/es/guide/deployment)** para el setup del contenedor y
**[Configuración →](/es/guide/configuration)** para cada flag.
