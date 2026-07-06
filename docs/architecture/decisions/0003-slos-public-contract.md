# SLOs as a public reliability contract

* Status: accepted
* Date: 2026-07-06
* Deciders: CarlxsMG (SRE), Claude Sonnet 5 (review)

## Context and Problem Statement

The bridge exposes Prometheus metrics (`mcp_proxy_request_duration_seconds`,
`audit_chain_ok`, `health_probe_success_total`, …) and ships an OTLP
tracer, but there is **no published contract** for what "the bridge is
working" means. Operators wiring alerts on the metrics have to pick their
own thresholds, which inevitably drift between deployments and end up
either too tight (noisy pages) or too loose (silent failures).

Worse, "is it up?" is a different question from "is the tool call path
healthy?", and the existing metrics conflate them:

* A 5xx from a specific backend pollutes the latency histogram and the
  error rate, but a 5xx from another backend doesn't — the histogram
  measures per-tool-call, not per-deployment.
* The audit chain has a binary property (it verifies, or it doesn't).
  Treating it as a 99.9% SLO is wrong; it either is intact or it is
  not, and the second state is a sev-1 page, not a metric to alert on.

The question: what is the minimum set of SLOs we promise an operator,
grounded in real metric names from `src/observability/metrics.ts`, and
how do we format them so they can be wired into a stock Prometheus /
Grafana alerting pipeline?

## Decision Drivers

* **Each SLO must be enforceable from the existing metrics.** No new
  metric, no SLO — if we have to add instrumentation to measure a
  promise, the promise is too expensive.
* **Percentage-window for throughput metrics, binary for invariants.**
  Tool-call availability is a percentage over a window. Audit chain
  integrity is binary. Mixing the two under a single "99.X%" framing
  would hide the difference.
* **Conservative for 1.0.0.** This is the first tagged release. The SLOs
  we promise now are the floor; we tighten them quarterly, never loosen.
* **Wireable to a stock 4-window burn-rate alert.** The Prometheus
  community's standard multi-window, multi-burn-rate alert pattern
  (1h short, 6h medium, 24h long, 72h very long) is the operator's
  default — we should match it.

## Considered Options

* **A. No public SLOs — operators pick their own thresholds.** Status quo.
  Rejected: silently offloads work to every operator; no shared ground
  truth for "this is a regression".
* **B. One SLO: "99% of requests succeed."** Rejected: collapses latency
  p99, audit integrity, and probe coverage into a single number that
  means nothing in particular.
* **C. Six SLOs across availability, latency, discovery, audit, and
  health, with the standard 4-window burn-rate alert template.** Chosen.

## Decision Outcome

Chosen option: **C — six SLOs, four windows, four burn-rates**.

The full set, each grounded in a real metric:

| SLO      | Window | Target          | Source metric                                       |
| -------- | ------ | --------------- | --------------------------------------------------- |
| SLO-1    | 30 d   | 99.5 %          | `mcp_proxy_request_total{status_class=~"2xx\|4xx"}` |
| SLO-2    | 30 d   | p95 ≤ 1 s, p99 ≤ 5 s | `mcp_proxy_request_duration_seconds` histogram  |
| SLO-3    | 30 d   | p99 ≤ 500 ms    | `mcp_tools_list_duration_seconds`                   |
| SLO-4    | 30 d   | 99 %            | `mcp_admin_api_request_total{status_class=~"2xx"}`  |
| SLO-5    | 24 h   | 100 % (binary)  | `mcp_audit_chain_ok` (1 = ok, 0 = broken)           |
| SLO-6    | 24 h   | ≥ 99 %          | `mcp_health_probe_success_total`                    |

SLO-1, SLO-2, and SLO-4 use the standard 4-window burn-rate alert
formulation (1 h × 14.4× budget, 6 h × 6×, 24 h × 4×, 72 h × 1×) so
operators can wire the doc's `PrometheusRule` example into their stack
without inventing alert thresholds.

SLO-5 (audit chain integrity) is binary: any non-1 reading pages sev-1
immediately. It does not use burn rates because "audit chain broken at
3 AM" is not a slow-burn problem.

SLO-6 (health probe coverage) tracks the auto-eviction loop — a backend
that fails its health probe gets evicted, so a missing probe means a
backend is stale but still in the registry.

### Consequences

* Good, because every SLO references an existing metric, so wiring an
  alert is a copy-paste from the doc to the operator's Prometheus config.
* Good, because the percentage-window and binary separation makes the
  contract honest — SLO-5 is "either it works or it doesn't", not a
  smoothed percentage that hides a hard break.
* Good, because the burn-rate thresholds are the community standard;
  operators who already run multi-window alerts get this for free.
* Good, because the targets are deliberately conservative for 1.0.0;
  the doc itself documents the quarterly review process for tightening.
* Bad, because committing to a public number means future regressions
  are now contract violations, not just metrics drift. Once a SLO is
  published, every tightening requires a CHANGELOG entry and a doc
  update.
* Bad, because the targets depend on the Prometheus exporter being
  enabled. An operator who disabled `/metrics` (e.g. to save scrape
  load) silently loses the ability to enforce these SLOs.

### Confirmation

* `docs/architecture/slos.md` and `docs/es/architecture/slos.md` publish
  the targets, the metric names, the windows, and the alert formulas.
* The metrics referenced exist in `src/observability/metrics.ts` and
  are exported by `/metrics` (no change to that path is needed).
* The W3C traceparent propagation (ADR-0002) makes latency-bucket
  violations diagnosable from a single trace — operators can find the
  slow call, not just the slow bucket.

## More Information

* Commit: `d2e491f` — `docs(slos): initial public reliability contract (P1-8)`
* Doc: `docs/architecture/slos.md` (and the Spanish mirror)
* Related code: `src/observability/metrics.ts`,
  `src/observability/tracing.ts`, `src/admin/audit/audit.ts`.