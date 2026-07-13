# Service Level Objectives (SLOs)

> **Status:** initial draft. Targets are **deliberately conservative for a 1.0.0
> self-hosted gateway** — the goal is to set a measurable bar, not to promise
> five-nines. Tighten after the first quarter of real production data.

This document is the **public reliability contract** for MCP REST Bridge. It binds the
gateway team (i.e. whoever is on call for this instance) to a set of promises about the
service, and binds consumers — MCP client users, operators, and auditors — to a clear
expectation of what "working" means.

SLOs are not SLAs. There is no financial credit in this document; it exists so that a
regression is a measurable event ("we burned 20% of the monthly error budget in 6 hours")
rather than a vibes-based argument in a post-mortem.

## Scope

**In scope:** the gateway process itself — Express app, registry, dispatch pipeline, admin
API, audit log, health/leader loops.

**Out of scope (delegated to the upstream owner):**

- Reliability of any individual backend. A backend that returns 5xx is recorded in
  `mcp_tool_calls_total{outcome="error"}` but does **not** count against the gateway's
  error budget — that's the backend's SLO.
- Reliability of the network between the gateway and a backend. Health-check failures
  attributable to a network partition are recorded in `mcp_health_loop_errors_total` and
  `mcp_health_check_runs_total{outcome="failure"}` and feed the **probe coverage** SLO
  (§[SLO-6](#slo-6-health-probe-coverage)), not the success-rate SLO.
- Reliability of the network between the MCP client and the gateway. TLS termination,
  ingress, and DDoS protection are operator concerns.
- MCP client correctness (timeouts, retries, parsing).

## SLO inventory

Each SLO is defined as: **ID · objective · SLI · target · window · error budget · alert**.

Each SLI below names the **actual signal it is measured from** — a Prometheus metric exposed
by the gateway where one exists (see `GET /metrics` and `src/observability/metrics.ts`), or an
audit route / reverse-proxy metric where noted (SLO-3, SLO-4, and SLO-5 are not gateway
metrics). The duration histogram buckets are `[0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30]`
seconds.

### SLO-1 — Tool call availability

|                     |                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**       | A tool call made on a healthy client returns a well-formed response — either a successful payload or a graceful, structured error — within the call timeout.                                                                                 |
| **SLI**             | `sum(rate(mcp_tool_calls_total{outcome="success"}[30d])) / sum(rate(mcp_tool_calls_total[30d]))`                                                                                                                                             |
| **Target**          | **99.5%** of tool calls succeed over a rolling 30-day window.                                                                                                                                                                                |
| **Window**          | 30 days rolling.                                                                                                                                                                                                                             |
| **Error budget**    | 0.5% of total tool calls = **~3.6 hours** of degraded calls per 30-day month at the current baseline of 1 call/sec.                                                                                                                          |
| **Alert**           | See [burn-rate alerts](#burn-rate-alerts) below. The 0.5% budget is checked at 1 h and 6 h windows.                                                                                                                                          |
| **Why this number** | The gateway is mostly idle on the happy path; the 0.5% budget covers (a) backend outages surfaced as fast 502/504 and (b) the occasional breaker trip. Tighter targets require per-backend SLOs and a circuit-breaker hardening pass (P0-1). |

A "well-formed response" is any response that the MCP client can parse — `isError: true`
results **count as success** for this SLO, because the gateway did its job by surfacing the
failure cleanly. What fails the SLO is a timeout (no response at all), a 5xx emitted by the
gateway itself, or a process crash.

### SLO-2 — Tool call latency

|                       |                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**         | Calls on healthy clients return within a human-perceptible budget, with a bounded tail.                                                                                                                                       |
| **SLI**               | `histogram_quantile(0.95, sum(rate(mcp_proxy_request_duration_seconds_bucket[30d])) by (le))` and the same for p99.                                                                                                           |
| **Target**            | **p95 ≤ 1 s** and **p99 ≤ 5 s** over 30 days.                                                                                                                                                                                 |
| **Window**            | 30 days rolling.                                                                                                                                                                                                              |
| **Error budget**      | Implicit — when p99 climbs past 10 s for 5 minutes, the alert fires regardless of the 30-day SLO.                                                                                                                             |
| **Alert**             | p99 > 10 s for 5 min → page. p95 > 2 s for 15 min → warn.                                                                                                                                                                     |
| **Why these numbers** | The 1 s / 5 s pair matches the histogram bucket boundaries, so each quantile is a real observed value, not an interpolation. Tighten p99 to 2 s once P0-1 (proxy pipeline refactor) and breaker half-open probing are stable. |

Latency is measured **at the gateway boundary** — the histogram starts when the
`proxyToolCall` handler begins and ends when the upstream response is fully received. Time
spent in MCP client → gateway network and TLS is **not** included.

### SLO-3 — Tool discovery latency

|                             |                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**               | An MCP client that opens a session and calls `tools/list` gets the catalog back fast enough to feel "instant".                                                                                                                                                                                                                      |
| **SLI**                     | p99 of the `tools/list` MCP request handler duration. **Not yet instrumented** — the OTLP tracer only emits a `tool_call <name>` span per `tools/call` (`src/proxy/proxy.ts`); `tools/list` gets no span or metric today. This SLO is aspirational until that handler is instrumented (or fronted by a reverse-proxy route metric). |
| **Target**                  | **p99 ≤ 500 ms** over 30 days.                                                                                                                                                                                                                                                                                                      |
| **Window**                  | 30 days rolling.                                                                                                                                                                                                                                                                                                                    |
| **Error budget**            | Implicit.                                                                                                                                                                                                                                                                                                                           |
| **Alert**                   | p99 > 1 s for 10 min → page.                                                                                                                                                                                                                                                                                                        |
| **Why this is its own SLO** | `tools/list` is a different workload from `tools/call` — it reads the in-memory registry, applies presentation overrides, and ships a possibly-large payload. We want to catch a slow registry or a payload-bloat regression separately from per-call latency.                                                                      |

### SLO-4 — Admin API availability

|                        |                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**          | Operators can manage the gateway — list clients, edit tools, view audit log, mint keys, trigger verify.                                                                                                                                                                                                                                                                          |
| **SLI**                | `sum(rate(http_requests_total{route=~"/admin-api/.*",status!~"5.."}[30d])) / sum(rate(http_requests_total{route=~"/admin-api/.*"}[30d]))`. **The gateway does not emit `http_requests_total`** — this SLI depends on a reverse proxy / ingress in front of the gateway exporting per-route HTTP metrics, and is not covered by the shipped `monitoring/` rules (SLO-1/2/6 only). |
| **Target**             | **99%** of admin requests return non-5xx over 30 days.                                                                                                                                                                                                                                                                                                                           |
| **Window**             | 30 days rolling.                                                                                                                                                                                                                                                                                                                                                                 |
| **Error budget**       | 1% = **~7.2 hours** of admin-API degraded state per 30-day month.                                                                                                                                                                                                                                                                                                                |
| **Alert**              | 5xx rate > 5% for 5 min → page.                                                                                                                                                                                                                                                                                                                                                  |
| **Why this is looser** | The admin API is operational, not user-facing. A 7-hour budget lets us ride out an entire deploy window without an incident.                                                                                                                                                                                                                                                     |

Admin API latency is **not** part of this SLO. Operators tolerate slow admin pages; tool
callers do not.

### SLO-5 — Audit chain integrity (binary)

|                        |                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**          | The hash-chain audit log is intact. Every row's `hash` matches its content and the previous row's `hash`.                                                                                                  |
| **SLI**                | The audit verify endpoint (`GET /admin-api/audit-log/verify` — see `src/routes/admin/audit-log.ts`) returns `ok: true` on every run.                                                                       |
| **Target**             | **100%** — no tolerance. A single failed verification is a sev-1.                                                                                                                                          |
| **Window**             | Per run. Run on a schedule (hourly is a reasonable default).                                                                                                                                               |
| **Error budget**       | **0.** No budget.                                                                                                                                                                                          |
| **Alert**              | Any `verify: false` result → page the security on-call immediately.                                                                                                                                        |
| **Why this is binary** | Audit integrity is not a gradient — either the chain is valid or it isn't. The hash chain is the property that lets us tell those apart, so any failure is a security event, not a performance regression. |

This SLO is a **detector**, not a target to meet. The right operational posture is to
never see the alert fire; if it does, the post-mortem is "what got modified, and by whom".

### SLO-6 — Health probe coverage {#slo-6-health-probe-coverage}

|                     |                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Objective**       | The leader-gated health-check loop probes every expected backend close to its scheduled cadence.                                                                                                                                                                                                                       |
| **SLI**             | `sum(rate(mcp_health_check_runs_total[24h])) / (expected_probes_per_second * 86400)`, where `expected_probes_per_second = (# registered clients) / HEALTH_CHECK_INTERVAL_MS * 1000`.                                                                                                                                   |
| **Target**          | **≥ 99%** of expected probes complete over 24 h.                                                                                                                                                                                                                                                                       |
| **Window**          | 24 h rolling.                                                                                                                                                                                                                                                                                                          |
| **Error budget**    | 1% of probe slots missed = ~14 min/day across all clients.                                                                                                                                                                                                                                                             |
| **Alert**           | Coverage < 95% for 30 min → page. `mcp_health_loop_errors_total` incrementing (unhandled errors in the loop) → page.                                                                                                                                                                                                   |
| **Why this exists** | The leader is the only node probing backends. If the leader stalls, the gateway stops evicting dead backends and tool calls keep timing out until something else notices. The `mcp_health_loop_errors_total` counter is the early-warning signal — any increment means the loop is swallowing exceptions it shouldn't. |

## Burn-rate alerts

The classic 4-window burn-rate formulation (from the Google SRE workbook) catches both
fast and slow budget consumption:

| Burn rate | Window | Alert      | Means                                                             |
| --------- | ------ | ---------- | ----------------------------------------------------------------- |
| **14.4×** | 1 h    | **Page**   | 2% of the 30-day budget gone in an hour. Something is on fire.    |
| **6×**    | 6 h    | **Page**   | 1% gone in 6 h. Sustained degradation.                            |
| **1×**    | 24 h   | **Ticket** | 5% of the 30-day budget gone in a day. Not a fire; not OK either. |
| **1×**    | 72 h   | **Ticket** | Slow burn. Usually a leaky regression.                            |

These are computed as:

```promql
# 1h burn at the 14.4x threshold, for SLO-1
(
  1 - (
    sum(rate(mcp_tool_calls_total{outcome="success"}[1h]))
    /
    sum(rate(mcp_tool_calls_total[1h]))
  )
) / 0.005 > 14.4
```

…with the analogous `6h / 6` and `24h / 1` and `72h / 1` variants. Ready-to-apply
Prometheus rules for these — and a Grafana dashboard — ship in the repo's `monitoring/`
directory; the gateway does not emit burn alerts itself.

**Why multi-window.** A single 30-day window hides a hot day inside a month of slack.
Multi-window alerting catches a Monday morning outage in time to do something about it,
not a month later when the budget is gone.

## What we do **not** SLO (and why)

- **Per-backend latency, success rate, or payload size.** That's the backend owner's
  SLO. The gateway can surface it; it cannot promise it.
- **MCP protocol correctness.** The `@modelcontextprotocol/sdk` handles framing; the
  MCP-protocol e2e test (`e2e/mcp-protocol.spec.ts`) covers the round-trip. If it
  fails, that's a bug, not a SLO miss.
- **Time-to-first-byte from a cold start.** Single Bun process, sub-second start in
  practice. If cold start ever becomes user-visible, it gets its own SLO.
- **"The dashboard loads in under 2 s."** Admin UI latency is a UX concern, not a
  reliability one — handle in the admin-ui repo, not here.

## Reviewing and changing SLOs

- **Quarterly.** Review the actual 30-day numbers, see if any target is consistently
  missed (target too tight) or consistently beaten by 10× (target too loose). Adjust the
  target, not the metric.
- **Never loosen a target to make a current outage "fit".** If the SLO is being missed,
  the SLO is doing its job. Open an incident.
- **Tightening requires a stakeholder conversation** — the people who depend on the SLO
  must agree the new bar is achievable, otherwise you create a chronic incident queue.
- **Document the change** in `CHANGELOG.md` and link the PR that adjusts the target.

## References

- `docs/guide/observability.md` — metric inventory, alert list, audit-log format.
- `docs/guide/scaling.md` — leader election, health loop, and what "horizontal" means for
  this gateway.
- `docs/guide/guardrails-resilience.md` — circuit breakers, rate limiters, canary.
- `src/observability/metrics.ts` — every metric name and label in this doc, defined there.
- `monitoring/` — ready-to-apply Prometheus alerting rules and a Grafana dashboard implementing the SLO-1/2/6 signals above.
- `src/admin/audit/audit.ts` — audit chain hash construction and verify path.
- [Google SRE Workbook, Ch. 5 — "Reliable Design" burn-rate alerting](https://sre.google/workbook/alerting-on-slos/).
