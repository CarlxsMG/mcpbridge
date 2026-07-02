# Features

Everything MCP REST Bridge does, grouped by what you're trying to accomplish.

## Connect anything

- **OpenAPI / Swagger → MCP auto-discovery.** Point at a spec URL; each operation becomes an
  MCP tool. Filter with `include_tags` / `exclude_operations`.
- **MCP → MCP gateway / aggregator.** Register existing MCP servers (Streamable HTTP or SSE)
  as upstreams and re-expose their tools through the same pipeline.
- **Manual tool definitions** when a backend has no spec.
- **Four serving modes** — aggregated `/mcp`, per-client `/mcp/:name`, curated bundles
  `/mcp-custom/:bundle`, and legacy SSE `/sse`.
- **Tool aliases & display names** to present clean, client-friendly tool names.
- **Composite / macro tools** that run several steps as one call, each step through the full
  guard stack.

## Govern & secure

- **SSRF + DNS-rebinding protection** on every backend URL, with the resolved IP pinned so a
  later DNS change can't redirect traffic.
- **Guardrails** — input deny-rules, secret detection, and prompt-injection sanitizing that
  wraps untrusted responses in a safe envelope.
- **Per-tool policy** — rate limits, timeouts, circuit-breaker overrides, and allowed-API-key
  restrictions, enforced at dispatch time before the circuit breaker.
- **RBAC** with `admin` / `operator` / `auditor` / `viewer` roles.
- **Team multi-tenancy** — scope clients to teams so tenants only see their own.
- **Session-based admin login** (argon2id via `Bun.password`) plus a static Bearer key path
  for CI/automation, with CSRF protection on cookie-authenticated mutations.

## Operate with confidence

- **Admin UI (Vue 3 SPA)** — dashboard, servers, bundles, API keys, consumers, policies,
  usage, alerts, schedules, audit log, users, teams and config.
- **Health monitoring + auto-eviction** of unhealthy backends, with a ping probe for MCP
  upstreams.
- **Canary / failover** — route to a validated secondary when a primary's breaker opens,
  without falsely closing the primary breaker.
- **Config versioning + rollback**, plus import/export of the whole configuration.
- **Maintenance schedules** via a built-in cron matcher (leader-gated, de-duplicated).

## Observe

- **Prometheus `/metrics`**, including `mcp_tool_calls_total{outcome}`.
- **OpenTelemetry (OTLP/HTTP) tracing** — a span per tool call when an OTLP endpoint is set.
- **Usage analytics** and **usage-anomaly / spike detection** that fires alerts via webhooks.
- **Tamper-evident audit log** — every admin action is hash-chained (`hash = SHA256(prev | …)`)
  and can be verified; optionally streamed to a SIEM.

## Scale (opt-in)

- **Shared rate counters** in SQLite for consistent limits across instances.
- **Cross-instance registry reconciliation** so registrations and removals propagate to peers.
- **Leader election** so background loops (alerts, schedules) run on exactly one instance.

## Runs anywhere

- **Bun single process** with **`bun:sqlite`** storage — no external database.
- **No Kubernetes required.** One Docker image, or `bun src/index.ts`.
- Minimal dependency surface — Bun's built-ins are used instead of extra npm packages
  wherever possible.
