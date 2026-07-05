# Observabilidad y monitorización

El bridge está construido para ser observado: métricas, traces, analytics de uso,
alertas y un log de auditoría a prueba de manipulaciones, todo desde la misma instancia.

## Métricas (Prometheus)

Scrape `GET /metrics` para métricas en formato Prometheus, incluyendo
`mcp_tool_calls_total{outcome}` junto con métricas de proceso y HTTP. Cablea en tus
dashboards y alertas habituales.

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
(`hash = SHA256(prev | actor | action | target | detail | created_at)`). Cualquier
edición retroactiva rompe la cadena y se detecta por el endpoint de verificación.
Streamea eventos a un SIEM en tiempo real con `AUDIT_SINK_URL`. Exporta el log como
JSON, CSV, o un reporte de compliance HTML autocontenido que embebe el veredicto de
verificación de la cadena de hashes.

## Salud

`GET /health` es un chequeo de liveness barato para load balancers. La salud de cada
backend se monitoriza continuamente, con auto-eliminación de backends no saludables y
un probe `ping` para upstreams MCP.

Siguiente: **[Escalado →](/es/guide/scaling)** · **[Solución de problemas →](/es/guide/troubleshooting)**
