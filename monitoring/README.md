# Monitoring — Prometheus rules & Grafana dashboard

Ready-to-apply observability artifacts for a self-hosted MCP REST Bridge instance. They
target the metrics the gateway actually exposes at `GET /metrics`
([`src/observability/metrics.ts`](../src/observability/metrics.ts)) and implement the
machine-checkable subset of the reliability contract in
[`docs/architecture/slos.md`](../docs/architecture/slos.md).

```
monitoring/
├── prometheus/alerts.yaml                 # alerting + recording rules (SLO-1, SLO-2, SLO-6 + ops)
└── grafana/mcp-rest-bridge-dashboard.json # importable gateway overview dashboard
```

## Prometheus

`GET /metrics` requires an admin session or an `ADMIN_API_KEYS` bearer token, so give the
scrape job the key:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: mcp-rest-bridge
    metrics_path: /metrics
    authorization:
      credentials: "<one of ADMIN_API_KEYS>"
    static_configs:
      - targets: ["mcp-rest-bridge:3000"]

rule_files:
  - /etc/prometheus/rules/mcp-rest-bridge.alerts.yaml
```

Validate the rules before shipping (CI-friendly, no running Prometheus needed):

```bash
promtool check rules monitoring/prometheus/alerts.yaml
```

## Grafana

Import `grafana/mcp-rest-bridge-dashboard.json` (Dashboards → New → Import). Grafana will
prompt for the `DS_PROMETHEUS` data source. Panels cover the tool-call success ratio and
latency quantiles (SLO-1/SLO-2), the error-budget burn rate, registry size, rate-limit
rejections, health-check throughput, and per-client circuit-breaker state.

## SLO coverage — what these files can and cannot check

Not every SLO in `slos.md` is a Prometheus rule; three of the six are deliberately measured
elsewhere. This table is the honest map so you don't assume coverage you don't have:

| SLO                              | Signal                                                        | Here?                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **SLO-1** tool-call availability | `mcp_tool_calls_total{outcome}`                               | ✅ burn-rate alerts + dashboard                                                                                                      |
| **SLO-2** tool-call latency      | `mcp_proxy_request_duration_seconds_bucket`                   | ✅ p95/p99 alerts + dashboard                                                                                                        |
| **SLO-6** health-probe coverage  | `mcp_health_loop_errors_total`, `mcp_health_check_runs_total` | ⚠️ loop-error alert active; the coverage-ratio rule is a commented template (needs your `HEALTH_CHECK_INTERVAL_MS`, default `30000`) |
| **SLO-3** tools/list latency     | OTLP span `mcp.tools.list`                                    | ❌ trace backend (Tempo/Jaeger), not `/metrics`                                                                                      |
| **SLO-4** admin-API availability | `http_requests_total{route,status}`                           | ❌ the gateway does not emit this — needs a reverse-proxy exporter (nginx/Envoy/Traefik) in front                                    |
| **SLO-5** audit-chain integrity  | `GET /admin-api/audit-log/verify` → `ok: true`                | ❌ binary check — wire as a blackbox/cron probe that pages on `ok:false`                                                             |

The operational alerts (circuit-breaker open, client eviction, rate-limit spikes,
response-size-cap rejections) are not SLOs — they are early-warning signals drawn from the
gateway's richer metric set.

> **Note on placeholders.** `runbook_url` links in `alerts.yaml` point at
> `github.com/aico-dot-team-code/mcpbridge`. If you fork or rehost, sweep that slug to your
> own so the runbook links resolve.
