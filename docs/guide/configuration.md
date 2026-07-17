# Configuration

MCP REST Bridge is configured with environment variables (Bun auto-loads a `.env` file in
development). The repository's **`.env.example`** is a curated, commented starter set. The tables
below cover the settings you'll reach for most often; the **[Advanced tuning](#advanced-tuning)**
section further down documents the operational knobs — timeouts, retries, circuit-breaker,
rate-limit and capacity limits — that most deployments never touch. Every variable is
range-validated at boot by `src/config-schema.ts`, which aborts startup (or logs a warning,
depending on `STRICT_CONFIG`) on an out-of-range value.

## First-boot & authentication

| Variable                      | Description                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_USERNAME`    | Username for the first admin user. Applied **only once**, while the users table is empty.                                                                                                                                                      |
| `BOOTSTRAP_ADMIN_PASSWORD`    | Password for that first admin (min 12 chars). Remove after the user exists.                                                                                                                                                                    |
| `ADMIN_API_KEYS`              | Comma-separated static Bearer keys for the JSON admin API (`/admin-api`, `/register`). Optional — the Vue UI uses session login.                                                                                                               |
| `MCP_API_KEYS`                | Comma-separated keys MCP clients present to call tools. Empty = no key required (combine with per-tool guards as needed).                                                                                                                      |
| `REQUIRE_MCP_AUTH`            | `true` forces the MCP data plane to fail **closed** even before a key exists (otherwise, with no keys/JWT configured, the data plane is open and a boot warning is logged).                                                                    |
| `EXPOSE_DOCS_UNAUTHENTICATED` | `true` serves `/docs` (Swagger UI + full OpenAPI spec) publicly. Off by default — `/docs` is admin-authenticated.                                                                                                                              |
| `AUTH_DISABLED`               | `true` turns **off all authentication** (admin API, MCP, sessions). Development only — outside `NODE_ENV=development` the bridge refuses to start unless `ALLOW_UNSAFE_AUTH_DISABLED=true` is also set. Never set either in a real deployment. |
| `ALLOW_UNSAFE_AUTH_DISABLED`  | Opt-out that lets `AUTH_DISABLED=true` take effect outside development. A deliberate footgun guard — leave unset.                                                                                                                              |

## Runtime & networking

| Variable                | Default                        | Description                                                                                                                                                                                                           |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `3000` (Docker) / `8790` (dev) | Backend listen port.                                                                                                                                                                                                  |
| `SESSION_COOKIE_SECURE` | `true`                         | Keep `true` in production (HTTPS). Set `false` only for local plain-HTTP dev.                                                                                                                                         |
| `NODE_ENV`              | —                              | `development` relaxes startup guards for local dev. **Never** in production.                                                                                                                                          |
| `TRUST_PROXY`           | `false`                        | Hop count (e.g. `1`) or CIDR/preset list matching your reverse-proxy topology — never bare `true`, which trusts every hop in `X-Forwarded-For` and lets a client spoof its IP. See [Deployment →](/guide/deployment). |
| `ALLOW_PRIVATE_IPS`     | `false`                        | Allow registering backends on loopback/private IPs. Local dev only — never in production.                                                                                                                             |
| `CORS_ORIGINS`          | —                              | Comma-separated origins allowed to call the admin API from a browser (CORS). Unset = no cross-origin admin access.                                                                                                    |
| `ALLOWED_ORIGINS`       | —                              | Comma-separated origins allowed to open an MCP session (`Origin`-header check on the data plane).                                                                                                                     |
| `ALLOWED_HOSTS`         | —                              | Comma-separated `Host` header values the gateway accepts, rejecting others — anti-DNS-rebinding for the gateway itself.                                                                                               |
| `STRICT_CONFIG`         | —                              | `production` upgrades config-validation warnings to hard errors and aborts boot — recommended in production so a misconfiguration fails fast instead of only logging a warning.                                       |

## Persistence

| Variable                | Description                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DB_PATH`               | SQLite file path (Docker default `/app/data/mcp-bridge.db`). Use `:memory:` for an ephemeral store.                            |
| `SECRET_ENCRYPTION_KEY` | Enables encrypting per-client upstream credentials at rest (AES-256-GCM). Base64 32 bytes, or any string (hashed to 32 bytes). |

### External secrets manager (optional)

Secrets at rest (OAuth2 client-credentials secrets, auto-provisioned MCP install-link keys) go
through a pluggable `SecretsProvider` (`src/secrets/`), not `SECRET_ENCRYPTION_KEY` directly. Two
backends are available:

- **`local`** (default) — the built-in secret-box above. Zero extra infrastructure; this is what
  `SECRET_ENCRYPTION_KEY` configures.
- **`vault`** — HashiCorp Vault's [Transit secrets engine](https://developer.hashicorp.com/vault/docs/secrets/transit)
  does the encrypt/decrypt instead, for operators required by policy to keep secret material in an
  external KMS. `SECRET_ENCRYPTION_KEY` is ignored in this mode.

| Variable                 | Default           | Description                                                                         |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `SECRETS_PROVIDER`       | `local`           | `local` or `vault`. Any other value fails fast at startup.                          |
| `VAULT_ADDR`             | —                 | Vault server address (e.g. `https://vault.example.com:8200`). Required for `vault`. |
| `VAULT_TOKEN`            | —                 | Vault token sent as `X-Vault-Token`. Required for `vault`.                          |
| `VAULT_TRANSIT_KEY_NAME` | `mcp-rest-bridge` | Name of the Vault Transit key used for encrypt/decrypt.                             |

If Vault is unreachable or returns an error, the operation fails with a clear error — it never
silently falls back to storing a secret in plaintext.

## Feature flags & integrations

| Variable                      | Description                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SEARCH_TOOL`          | Toggle the synthetic `search_tools` meta-tool (default on).                                                                              |
| `AUDIT_SINK_URL`              | Stream every audit event to a SIEM/HTTP sink.                                                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export a trace span per tool call (OTLP/HTTP).                                                                                           |
| `RATE_LIMIT_SHARED`           | `true` = SQLite-backed cross-instance rate counters (HA).                                                                                |
| `REGISTRY_SYNC`               | `true` = reconcile the registry from SQLite across instances (HA).                                                                       |
| `AUTO_GATE_WRITE_METHODS`     | `true` = treat DELETE/PUT tools as sensitive by default, requiring step-up confirmation (per-tool overrides still win). Default `false`. |

## Proxy behavior

These tune the newer per-tool proxy features (caching, load balancing, traffic capture, approvals,
synthetic monitoring). Each feature is opt-in per tool/client from the admin API; these are just the
global knobs.

| Variable                | Default | Description                                                            |
| ----------------------- | ------- | ---------------------------------------------------------------------- |
| `CACHE_MAX_ENTRIES`     | `10000` | Max in-memory cached tool responses (LRU-evicted).                     |
| `LB_TARGET_COOLDOWN_MS` | `30000` | How long a load-balanced target is skipped after a failed call.        |
| `TRAFFIC_CAPTURE`       | `false` | Capture per-call args + result preview for the admin traffic explorer. |
| `TRAFFIC_RETENTION_MS`  | 7 days  | Retention window for captured traffic before pruning.                  |
| `APPROVAL_WEBHOOK_URL`  | —       | Fire-and-forget notification when a call is queued for human approval. |
| `MONITOR_WEBHOOK_URL`   | —       | Notification when a synthetic monitor fails or detects schema drift.   |

## Inbound JWT auth (optional)

Accept OAuth2/OIDC access tokens as an MCP credential, verified against a JWKS endpoint (RS256/ES256,
via WebCrypto — no extra dependency). Additive to `MCP_API_KEYS` and DB-managed keys; setting
`JWT_JWKS_URL` also locks the surface down (like minting a managed key).

| Variable                       | Description                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `JWT_JWKS_URL`                 | JWKS endpoint. When set, MCP auth also accepts a valid RS256/ES256 JWT bearer.                                        |
| `JWT_ISSUER`                   | Required `iss` claim (optional — rejected on mismatch when set).                                                      |
| `JWT_AUDIENCE`                 | Required `aud` claim — token must list it. **Mandatory in production when `JWT_JWKS_URL` is set** (see warning).      |
| `ALLOW_UNSAFE_JWT_NO_AUDIENCE` | Escape hatch to run `JWT_JWKS_URL` without `JWT_AUDIENCE` outside development. Unsafe — see warning. Default `false`. |

::: warning Audience binding is required in production
With `JWT_JWKS_URL` set but `JWT_AUDIENCE` empty, **any** token validly signed by that JWKS is accepted regardless of the audience it was minted for — in a shared IdP, a token issued for an unrelated app becomes a valid gateway credential (a cross-audience privilege grant). Outside development the bridge therefore **refuses to start** in this configuration unless you also set `ALLOW_UNSAFE_JWT_NO_AUDIENCE=true`. Set `JWT_AUDIENCE` to the gateway's own audience instead.
:::

## Advanced tuning

Operational knobs with sensible defaults — you rarely need to change any of them, but they're
documented here so you don't have to read the source to find one. All durations are milliseconds;
all rate limits are requests-per-minute per source unless noted. Values are range-validated at
boot (`src/config-schema.ts`).

### Timeouts, retries & response limits

| Variable                 | Default    | Purpose                                                                            |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `TOOL_CALL_TIMEOUT_MS`   | `30000`    | Per-tool-call timeout on the outbound backend request.                             |
| `RETRY_MAX_ATTEMPTS`     | `2`        | Retries for idempotent requests (total attempts = this + 1). `0` disables retries. |
| `RETRY_BASE_DELAY_MS`    | `500`      | Base delay for exponential backoff between retries.                                |
| `RETRY_AFTER_MAX_MS`     | `30000`    | Ceiling honoured from an upstream `Retry-After` header.                            |
| `MAX_RESPONSE_BYTES`     | `10485760` | Max upstream response body (10 MiB); larger responses are rejected.                |
| `SHUTDOWN_FORCE_EXIT_MS` | `10000`    | Grace period before a `SIGTERM` shutdown force-exits.                              |

### Circuit breaker & health checks

| Variable                               | Default | Purpose                                                            |
| -------------------------------------- | ------- | ------------------------------------------------------------------ |
| `CIRCUIT_BREAKER_WINDOW_MS`            | `60000` | Sliding window over which per-tool failures are counted.           |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD`    | `3`     | Failures within the window that trip a breaker open.               |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`     | `30000` | How long an open breaker waits before a half-open probe.           |
| `CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS` | `5000`  | Timeout applied to the single half-open probe request.             |
| `MAX_CONSECUTIVE_FAILURES`             | `3`     | Consecutive health-check failures before a client is auto-evicted. |
| `HEALTH_CHECK_INTERVAL_MS`             | `30000` | Interval between background health-check passes.                   |
| `HEALTH_CHECK_TIMEOUT_MS`              | `5000`  | Per-client health-probe timeout.                                   |
| `HEALTH_CHECK_MAX_CONCURRENT`          | `20`    | Max concurrent health checks per batch.                            |

### Rate limiting

The `*_MAX_BUCKETS_*` values cap the LRU maps that hold per-source counters — raise them only if
you serve very many distinct source IPs and see bucket eviction churn.

| Variable                              | Default  | Purpose                                                 |
| ------------------------------------- | -------- | ------------------------------------------------------- |
| `RATE_LIMIT_MCP`                      | `100`    | Per-session limit on MCP data-plane calls.              |
| `RATE_LIMIT_REGISTER`                 | `10`     | Per-IP limit on `POST /register`.                       |
| `RATE_LIMIT_GLOBAL`                   | `1000`   | Per-IP global request ceiling.                          |
| `RATE_LIMIT_LOGIN`                    | `10`     | Per-IP limit on `POST /admin-api/auth/login`.           |
| `RATE_LIMIT_INSTALL_LINK`             | `20`     | Per-IP limit on the public `GET /install/:token` route. |
| `RATE_LIMIT_CLEANUP_INTERVAL_MS`      | `300000` | Interval between rate-limiter bucket-cleanup passes.    |
| `RATE_LIMIT_MAX_BUCKETS_GLOBAL`       | `50000`  | Max LRU buckets in the global limiter map.              |
| `RATE_LIMIT_MAX_BUCKETS_MCP`          | `100000` | Max LRU buckets in the MCP-session limiter map.         |
| `RATE_LIMIT_MAX_BUCKETS_REGISTER`     | `10000`  | Max LRU buckets in the register limiter map.            |
| `RATE_LIMIT_MAX_BUCKETS_TOOL`         | `20000`  | Max LRU buckets in the per-tool guard limiter map.      |
| `RATE_LIMIT_MAX_BUCKETS_LOGIN`        | `5000`   | Max LRU buckets in the login limiter map.               |
| `RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK` | `5000`   | Max LRU buckets in the install-link limiter map.        |

### Capacity & sessions

| Variable                  | Default    | Purpose                                                  |
| ------------------------- | ---------- | -------------------------------------------------------- |
| `MAX_TOOLS_PER_CLIENT`    | `100`      | Max tools accepted in a single `/register` payload.      |
| `MAX_JSON_DEPTH`          | `32`       | Max JSON nesting depth accepted in request bodies.       |
| `MAX_SESSIONS`            | `100`      | Max concurrent in-memory MCP (Streamable HTTP) sessions. |
| `SESSION_TTL_MS`          | `1800000`  | Idle TTL for an MCP data-plane session (30 min).         |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000`  | Sliding idle timeout for an **admin** session (30 min).  |
| `SESSION_ABSOLUTE_TTL_MS` | `43200000` | Absolute cap on an admin session's lifetime (12 h).      |

### Discovery (OpenAPI / GraphQL)

| Variable                       | Default | Purpose                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------- |
| `OPENAPI_DISCOVERY_TIMEOUT_MS` | `10000` | Timeout for fetching/parsing an OpenAPI spec at registration.   |
| `GRAPHQL_DISCOVERY_TIMEOUT_MS` | `10000` | Timeout for a GraphQL introspection query at registration.      |
| `GRAPHQL_MAX_TYPES`            | `2000`  | Width cap on `__schema.types` during introspection.             |
| `GRAPHQL_SELECTION_MAX_DEPTH`  | `2`     | Depth cap for auto-synthesized selection sets.                  |
| `GRAPHQL_INPUT_MAX_DEPTH`      | `3`     | Depth cap for mapping nested INPUT_OBJECT types to JSON Schema. |

### WebSocket proxy

| Variable                             | Default   | Purpose                                                     |
| ------------------------------------ | --------- | ----------------------------------------------------------- |
| `WS_PROXY_MAX_GLOBAL_CONNECTIONS`    | `500`     | Ceiling on concurrent proxied WebSocket connections.        |
| `WS_PROXY_DEFAULT_MAX_CONNECTIONS`   | `10`      | Default per-target connection cap (overridable per target). |
| `WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES` | `1048576` | Default max WS message size (1 MiB).                        |
| `WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS`   | `300000`  | Default idle timeout before a proxied WS is closed (5 min). |
| `WS_PROXY_DIAL_TIMEOUT_MS`           | `10000`   | Timeout for dialing the upstream WebSocket.                 |
| `WS_PROXY_REVALIDATE_INTERVAL_MS`    | `60000`   | Interval for re-validating a target's pinned IP.            |

### Tracing, metrics & data retention

| Variable                 | Default           | Purpose                                                |
| ------------------------ | ----------------- | ------------------------------------------------------ |
| `METRICS_ENABLED`        | `true`            | Set `false` to disable the `/metrics` endpoint.        |
| `OTEL_SERVICE_NAME`      | `mcp-rest-bridge` | `service.name` resource attribute on exported spans.   |
| `OTEL_MAX_BATCH`         | `128`             | Spans buffered before a flush is forced.               |
| `OTEL_EXPORT_TIMEOUT_MS` | `5000`            | Timeout for an OTLP export POST.                       |
| `TRACE_STORAGE`          | `false`           | Persist spans to SQLite for the built-in trace viewer. |
| `TRACE_RETENTION_MS`     | `86400000`        | Retention for persisted spans (24 h).                  |
| `USAGE_RETENTION_MS`     | `2592000000`      | Retention for per-call usage rows (30 days).           |
| `TRAFFIC_MAX_BODY_BYTES` | `8192`            | Max chars stored per captured traffic result preview.  |

### Alerts & anomaly detection

| Variable                     | Default   | Purpose                                                 |
| ---------------------------- | --------- | ------------------------------------------------------- |
| `ALERT_INTERVAL_MS`          | `30000`   | How often the leader evaluates alert rules.             |
| `ALERT_WEBHOOK_TIMEOUT_MS`   | `5000`    | Timeout for an outbound alert-webhook delivery.         |
| `ALERT_ERROR_RATE_WINDOW_MS` | `300000`  | Sliding window for error-rate alert evaluation (5 min). |
| `ANOMALY_RECENT_WINDOW_MS`   | `300000`  | Recent window for usage-spike detection (5 min).        |
| `ANOMALY_BASELINE_WINDOW_MS` | `3600000` | Baseline window for usage-spike detection (1 h).        |

### Integration timeouts & HA

| Variable                        | Default     | Purpose                                                                  |
| ------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `APPROVAL_WEBHOOK_TIMEOUT_MS`   | `5000`      | Timeout for an approval-notification webhook.                            |
| `MONITOR_WEBHOOK_TIMEOUT_MS`    | `5000`      | Timeout for a monitor-notification webhook.                              |
| `AUDIT_SINK_TIMEOUT_MS`         | `3000`      | Timeout for an audit-sink (`AUDIT_SINK_URL`) delivery.                   |
| `OAUTH_TOKEN_TIMEOUT_MS`        | `10000`     | Timeout for an outbound OAuth2 client-credentials token request.         |
| `JWT_JWKS_CACHE_MS`             | `600000`    | How long a fetched JWKS is cached (10 min).                              |
| `JWT_JWKS_TIMEOUT_MS`           | `5000`      | Timeout for a JWKS fetch.                                                |
| `VAULT_REQUEST_TIMEOUT_MS`      | `5000`      | Timeout for a Vault Transit encrypt/decrypt request.                     |
| `CONTEXT_BUDGET_LLM_TIMEOUT_MS` | `15000`     | Timeout for the opt-in per-tool `llm_summarize` compression call.        |
| `LEADER_LEASE_DURATION_MS`      | `15000`     | Duration of the leader-election lease.                                   |
| `REGISTRY_SYNC_INTERVAL_MS`     | `15000`     | Interval between registry reconciliation passes (needs `REGISTRY_SYNC`). |
| `INSTANCE_ID`                   | random UUID | Stable identity for this process in leader-election bookkeeping.         |

### CORS fine-tuning & logging

| Variable                     | Default | Purpose                                                          |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `CORS_MAX_AGE_SECONDS`       | `600`   | Preflight cache duration (`Access-Control-Max-Age`).             |
| `CORS_ALLOW_CREDENTIALS`     | `false` | Send `Access-Control-Allow-Credentials` for allowlisted origins. |
| `ALLOW_UNSAFE_CORS_WILDCARD` | `false` | Permit a `*` in `CORS_ORIGINS` while auth is enabled (unsafe).   |
| `LOG_FORMAT`                 | `json`  | `json` or `text` structured-log output.                          |

::: tip
Generate keys/secrets with, e.g., `openssl rand -hex 24` (API keys) or
`openssl rand -base64 32` (`SECRET_ENCRYPTION_KEY`). `.env.example` is a curated starter set; this
page (plus **[Advanced tuning](#advanced-tuning)** above) documents every variable, and
`src/config-schema.ts` enforces the accepted range for each one at boot.
:::

Next: **[Deployment →](/guide/deployment)** · **[Security →](/guide/security)**
