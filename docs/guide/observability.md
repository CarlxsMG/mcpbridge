# Observability & monitoring

The bridge is built to be watched: metrics, traces, usage analytics, alerts and a
tamper-evident audit trail, all from the same instance.

## Metrics (Prometheus)

Scrape `GET /metrics` for Prometheus-format metrics, including
`mcp_tool_calls_total{outcome}` alongside process and HTTP metrics. Wire it into your usual
dashboards and alerting — or start from the ready-to-apply Prometheus rules and Grafana
dashboard in the repo's `monitoring/` directory.

## Tracing (OpenTelemetry)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the bridge exports one OTLP/HTTP span **per tool call**
— dependency-free, so you can send spans to any OTLP collector (Jaeger, Tempo, Honeycomb, …).

## Usage analytics & anomaly detection

The admin UI's **Usage** view shows calls, error rate, latency, top tools and per-key
breakdowns over a window — the same window the `usage_spike` alert below watches.

## Alerts

Create alert rules that POST to a webhook on:

| Event                  | Fires when                                          |
| ---------------------- | --------------------------------------------------- |
| `circuit_breaker_open` | A tool's breaker trips open                         |
| `client_unreachable`   | A backend fails health checks                       |
| `error_rate`           | Errors exceed a threshold over a minimum call count |
| `usage_spike`          | Traffic spikes vs. baseline                         |

**Synthetic monitors** can additionally probe tools on a schedule and notify
`MONITOR_WEBHOOK_URL` on failure or schema drift.

## Audit trail

Every admin mutation is written to a **hash-chained** audit log
(`hash = SHA256(prev | actor | action | target | detail | created_at)`). Any retroactive
edit breaks the chain and is caught by the verify endpoint. Stream events to a SIEM in real
time with `AUDIT_SINK_URL`. Export the log as JSON, CSV, or a self-contained HTML compliance
report that embeds the hash-chain verification verdict.

## Health

`GET /health` is a cheap liveness check for load balancers. Per-backend health is monitored
continuously, with automatic eviction of unhealthy backends and a `ping` probe for MCP
upstreams.

Next: **[Scaling →](/guide/scaling)** · **[Troubleshooting →](/guide/troubleshooting)**
