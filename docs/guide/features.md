# Features

Everything MCP REST Bridge does, grouped by what you're trying to accomplish. Each group links
to the guide that covers it in depth.

## Connect anything

See **[Registering backends →](/guide/registering-backends)**.

- **OpenAPI / Swagger → MCP auto-discovery.** Point at a spec URL; each operation becomes an
  MCP tool. Filter with `include_tags` / `exclude_operations`.
- **GraphQL → MCP auto-discovery.** Point at a GraphQL endpoint; the bridge introspects the
  schema and generates one tool per query/mutation.
- **cURL / Postman import.** Derive tools from a pasted `curl` command or a Postman
  Collection v2.1 export when there's no spec.
- **MCP → MCP gateway / aggregator.** Register existing MCP servers (Streamable HTTP or SSE)
  as upstreams and re-expose their tools through the same pipeline.
- **Manual tool definitions** when a backend has no spec.
- **Four serving modes** — aggregated `/mcp`, per-client `/mcp/:name`, curated bundles
  `/mcp-custom/:bundle`, and legacy SSE `/sse`.
- **Tool aliases & display names** to present clean, client-friendly tool names.
- **Tool tags** — free-form tags across every registered client, browsable and filterable by
  tag from the admin UI.
- **Composite / macro tools** that run several steps as one call, each step through the full
  guard stack.
- **GraphQL & WebSocket backends** (per-tool) — wrap a call's arguments as a GraphQL
  `{ query, variables }` request, or do an ephemeral request/response over a WebSocket, reusing the
  same guard stack as REST.
- **Dedicated WebSocket proxy targets** — register a persistent backend WS endpoint (with
  connection-count, message-size and idle-timeout limits), and force-disconnect every active
  connection to one in bulk.
- **Upstream resources & prompts** — a per-client `/mcp/:name` endpoint pointed at an MCP server now
  passes through its resources and prompts, not only its tools.
- **Bundle install links** — a shareable, revocable one-click link that mints a bundle-scoped
  MCP API key and resolves to a ready-to-paste connection snippet, so end users never need a
  manually provisioned key.

## Govern & secure

See **[Security →](/guide/security)**, **[Guardrails & resilience →](/guide/guardrails-resilience)**,
and **[Access control →](/guide/access-control)**.

**Network & content safety**

- **SSRF + DNS-rebinding protection** on every backend URL, with the resolved IP pinned so a
  later DNS change can't redirect traffic.
- **Guardrails** — input deny-rules, secret detection, and prompt-injection sanitizing that
  wraps untrusted responses in a safe envelope.
- **Per-tool policy** — rate limits, timeouts, circuit-breaker overrides, and allowed-API-key
  restrictions, enforced at dispatch time before the circuit breaker.

**Access & identity**

- **RBAC** with `admin` / `operator` / `auditor` / `viewer` roles.
- **Team multi-tenancy** — scope clients to teams so tenants only see their own.
- **Session-based admin login** (argon2id via `Bun.password`) plus a static Bearer key path
  for CI/automation, with CSRF protection on cookie-authenticated mutations.
- **Inbound OAuth2 / JWT** (optional) — accept OAuth2/OIDC access tokens (RS256/ES256) verified
  against a JWKS endpoint, alongside static and DB-managed keys. No extra dependency (WebCrypto).
- **Outbound OAuth2 client-credentials** — the bridge mints and auto-refreshes a token from the
  backend's token endpoint and injects it, so the MCP caller never sees the real client secret.

**Control & workflow**

- **Human-in-the-loop approval** — high-risk tools can require an out-of-band admin approval; the
  call files a ticket bound to its exact arguments and is single-use once approved.
- **Declarative request/response transforms** — reshape a tool's args or JSON response
  (set / remove / rename / copy) without code and with no expression eval to exploit.

## Operate with confidence

**Admin UI & config**

- **Admin UI (Vue 3 SPA)** — dashboard, servers, bundles, API keys, consumers, policies,
  usage, alerts, schedules, audit log, users, teams and config.
- **Customizable widget dashboard** — a Grafana-style Overview grid: add, resize and configure
  stat/chart/note widgets from a catalog, then export or import the whole layout.
- **Config versioning + rollback**, plus import/export of the whole configuration.
- **Maintenance schedules** via a built-in cron matcher (leader-gated, de-duplicated).

**Resilience** — see **[Guardrails & resilience →](/guide/guardrails-resilience)**

- **Health monitoring + auto-eviction** of unhealthy backends, with a ping probe for MCP
  upstreams.
- **Canary / failover** — route to a validated secondary when a primary's breaker opens,
  without falsely closing the primary breaker.
- **Response caching** — per-tool TTL + LRU cache for idempotent `GET` responses, served after all
  guards but before the circuit breaker (a cache hit never burns a half-open probe).
- **N-way load balancing** — spread a client's calls across a pool of upstream targets
  (round-robin / weighted / least-connections) with a per-target health cooldown, on top of the
  primary circuit breaker.

**Data handling**

- **Auto-pagination** — follow cursor / page / RFC-5988 `Link` pagination and aggregate the pages
  into one response (same-host only, SSRF-safe).
- **Streaming normalization** — turn an NDJSON or SSE response into a single aggregated JSON result.
- **Mock / virtualization** — serve a canned response (always, for contract-first development) or
  only as a fallback when the backend is unavailable.

## Observe

See **[Observability & monitoring →](/guide/observability)**.

- **Prometheus `/metrics`**, including `mcp_tool_calls_total{outcome}`.
- **OpenTelemetry (OTLP/HTTP) tracing** — a span per tool call when an OTLP endpoint is set.
- **Usage analytics** and **usage-anomaly / spike detection** that fires alerts via webhooks.
- **Tamper-evident audit log** — every admin action is hash-chained (`hash = SHA256(prev | …)`)
  and can be verified; optionally streamed to a SIEM.
- **Traffic explorer + replay** — opt-in per-call capture (arguments + a result preview) you can
  inspect and re-run from the admin API.
- **Synthetic monitoring + schema-drift** — periodically replay a saved example through a tool and
  flag failures, and detect when an upstream's input schema drifts from a captured baseline.

## Scale (opt-in)

See **[Scaling & high availability →](/guide/scaling)**.

- **Shared rate counters** in SQLite for consistent limits across instances.
- **Cross-instance registry reconciliation** so registrations and removals propagate to peers.
- **Leader election** so background loops (alerts, schedules) run on exactly one instance.

## Runs anywhere

Bun single process + `bun:sqlite` — no external database, no Kubernetes. See
**[Deployment →](/guide/deployment)** for Docker, bare-metal and reverse-proxy setup.

Next: **[Getting started →](/guide/getting-started)** · **[Why MCP REST Bridge →](/guide/why-mcp-rest-bridge)**
