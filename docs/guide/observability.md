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
(`hash = SHA256(JSON.stringify([prev_hash, actor, action, target, detail, created_at]))`) —
a JSON-encoded pre-image rather than a bare delimiter join, since caller-influenced fields
like `target` and `detail` could otherwise collide across distinct rows. Any retroactive
edit breaks the chain and is caught by the verify endpoint. Stream events to a SIEM in real
time with `AUDIT_SINK_URL`. Export the log as JSON, CSV, or a self-contained HTML compliance
report that embeds the hash-chain verification verdict.

## Health

`GET /livez` is a cheap liveness check — always 200 if the process is responding. `GET /readyz`
is the readiness check: 200 only when this instance holds the leader lease and its SQLite
handle answers `SELECT 1`. Request handling (REST/MCP dispatch) is stateless and runs on every
instance regardless of leadership, so a load balancer scaling throughput should route on
`/health` or `/livez` — pointing it at `/readyz` takes every non-leader instance out of
rotation. Reserve `/readyz`-gated routing for a deliberate active/passive failover topology.
Per-backend health is monitored continuously, with automatic eviction of unhealthy backends and
a `ping` probe for MCP upstreams.

Next: **[Scaling →](/guide/scaling)** · **[Troubleshooting →](/guide/troubleshooting)**
