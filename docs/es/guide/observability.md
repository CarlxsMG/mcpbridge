# Observabilidad y monitorización

El bridge está construido para ser observado: métricas, traces, analytics de uso,
alertas y un log de auditoría a prueba de manipulaciones, todo desde la misma instancia.

## Métricas (Prometheus)

Scrape `GET /metrics` para métricas en formato Prometheus. El endpoint expone únicamente las
métricas `mcp_*` propias del gateway — las de su registro, resiliencia, chequeos de salud y
proxy WS (por ejemplo `mcp_tool_calls_total{outcome}`). **No** exporta métricas de proceso ni
de HTTP por defecto (no hay `prom-client` / `collectDefaultMetrics` — sin `process_*`,
`nodejs_*` ni métricas de request por ruta). Cablea en tus dashboards y alertas habituales — o
parte de las reglas Prometheus y el dashboard Grafana listos para aplicar en el directorio
`monitoring/` del repo.

## Tracing (OpenTelemetry)

Define `OTEL_EXPORTER_OTLP_ENDPOINT` y el bridge exporta un span OTLP/HTTP
**por cada llamada de tool** — sin dependencias, así que puedes enviar spans a cualquier
collector OTLP (Jaeger, Tempo, Honeycomb, …).

## Analytics de uso y detección de anomalías

La vista **Usage** de la UI de admin muestra llamadas, tasa de error, latencia, top
tools y breakdowns por key en una ventana — la misma ventana que la alerta `usage_spike`
de abajo monitoriza.

## Alertas

Crea reglas de alerta que POSTean a un webhook en:

| Evento                 | Se dispara cuando                                            |
| ---------------------- | ------------------------------------------------------------ |
| `circuit_breaker_open` | El breaker de una tool se dispara y abre                     |
| `client_unreachable`   | Un backend falla los chequeos de salud                       |
| `error_rate`           | Los errores superan un threshold sobre un mínimo de llamadas |
| `usage_spike`          | Picos de tráfico vs. baseline                                |

Los **monitores sintéticos** pueden adicionalmente probar tools en schedule y notificar a
`MONITOR_WEBHOOK_URL` ante fallo o drift de schema.

## Log de auditoría

Cada mutación admin se escribe en un **log de auditoría encadenado por hash**
(`hash = SHA256(JSON.stringify([prev_hash, actor, action, target, detail, created_at]))`) —
una pre-imagen codificada en JSON, no una unión por delimitador, ya que campos influenciados
por el caller como `target` y `detail` podrían colisionar entre filas distintas. Cualquier
edición retroactiva rompe la cadena y se detecta por el endpoint de verificación.
Streamea eventos a un SIEM en tiempo real con `AUDIT_SINK_URL`. Exporta el log como
JSON, CSV, o un reporte de compliance HTML autocontenido que embebe el veredicto de
verificación de la cadena de hashes.

## Salud

`GET /livez` es un chequeo de liveness barato — siempre 200 si el proceso responde.
`GET /readyz` es el chequeo de disponibilidad: 200 solo cuando esta instancia mantiene el
leader lease y su handle de SQLite responde `SELECT 1`. El manejo de requests (dispatch
REST/MCP) es stateless y corre en cada instancia sin importar el liderazgo, así que un load
balancer que escala throughput debería enrutar sobre `/health` o `/livez` — apuntarlo a
`/readyz` saca de rotación a cada instancia que no es líder. Reserva el enrutamiento
condicionado a `/readyz` para una topología deliberada de failover activo/pasivo. La salud de
cada backend se monitoriza continuamente, con auto-eliminación de backends no saludables y un
probe `ping` para upstreams MCP.

Siguiente: **[Escalado →](/es/guide/scaling)** · **[Solución de problemas →](/es/guide/troubleshooting)**
