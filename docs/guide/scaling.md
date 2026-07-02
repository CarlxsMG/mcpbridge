# Scaling & high availability

MCP REST Bridge runs happily as a single process — one Bun instance with a local
SQLite file handles a lot. When you need redundancy or more throughput, it scales
horizontally: run several identical instances behind a load balancer, coordinated
through a shared SQLite database.

## The model

- **Stateless request handling.** Each tool call is self-contained; any instance can
  serve any REST call.
- **SQLite is the coordination layer.** Admin config, guards, keys, audit, usage and
  the HA primitives all live in the database. Point every instance at the **same**
  `DB_PATH` (shared storage / a shared volume) so they see one config.
- **Opt-in HA flags** turn on cross-instance behaviour (below) — they're off by default
  so a single node stays simple.

<ScaleOut />

## Turn on the HA primitives

| Setting | Effect |
|---|---|
| `RATE_LIMIT_SHARED=true` | Rate limits use SQLite fixed-window counters, so a per-tool limit is enforced across **all** instances, not per-process. |
| `REGISTRY_SYNC=true` | Each instance periodically reconciles its live registry from SQLite — a client registered (or removed) on one node propagates to the others. |
| *(automatic)* leader election | Background loops that must run **once** — alert evaluation, maintenance schedules — elect a single leader via a SQLite lease. No configuration needed. |

## Load balancing your backends

Separately from scaling the bridge itself, a single tool can fan out across **several
backend targets** (N-way load balancing), configured per tool from the admin API. A
target that fails is skipped for `LB_TARGET_COOLDOWN_MS` (default 30s) before it's tried
again. Combine with per-client **canary/failover** (see [Guardrails & resilience](/guide/guardrails-resilience))
for graceful degradation.

## MCP sessions & sticky routing

The **Streamable HTTP** and **SSE** transports keep per-session state **in memory** on
the instance that opened the session. Two options:

- **Sticky sessions** — enable session affinity on your load balancer for `/mcp`, `/sse`
  and `/messages` so a session stays on one instance. Recommended for streaming clients.
- **Stateless calls** — clients that open a fresh request per call don't need affinity and
  balance freely.

REST proxying and the admin API need no affinity.

## Caveats to know

- **Shared SQLite requires shared storage.** SQLite over a network filesystem has locking
  quirks; prefer a volume all instances mount locally, or keep writes modest. For very high
  write volume, run fewer, larger instances.
- **The audit hash-chain is per-instance.** Its tamper-evidence (`verifyAuditChain`) assumes
  one writer; cross-instance chain integrity is out of scope — stream to a SIEM
  (`AUDIT_SINK_URL`) for a consolidated, ordered record instead.

## Checklist

- [ ] All instances share one `DB_PATH`
- [ ] `RATE_LIMIT_SHARED=true` and `REGISTRY_SYNC=true`
- [ ] Load balancer health-checks `/health`
- [ ] Sticky sessions for `/mcp` · `/sse` · `/messages` (if you use streaming)
- [ ] `AUDIT_SINK_URL` set for a consolidated audit trail

See **[Deployment →](/guide/deployment)** for the container setup and
**[Configuration →](/guide/configuration)** for every flag.
