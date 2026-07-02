# Configuration

MCP REST Bridge is configured with environment variables (Bun auto-loads a `.env` file in
development). The repository's **`.env.example`** is the authoritative, commented list — the
tables below cover the settings you'll reach for most often.

## First-boot & authentication

| Variable | Description |
|---|---|
| `BOOTSTRAP_ADMIN_USERNAME` | Username for the first admin user. Applied **only once**, while the users table is empty. |
| `BOOTSTRAP_ADMIN_PASSWORD` | Password for that first admin (min 12 chars). Remove after the user exists. |
| `ADMIN_API_KEYS` | Comma-separated static Bearer keys for the JSON admin API (`/admin-api`, `/register`). Optional — the Vue UI uses session login. |
| `MCP_API_KEYS` | Comma-separated keys MCP clients present to call tools. Empty = no key required (combine with per-tool guards as needed). |

## Runtime & networking

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` (Docker) / `8790` (dev) | Backend listen port. |
| `SESSION_COOKIE_SECURE` | `true` | Keep `true` in production (HTTPS). Set `false` only for local plain-HTTP dev. |
| `NODE_ENV` | — | `development` relaxes startup guards for local dev. **Never** in production. |
| `TRUST_PROXY` | `false` | Enable **only** when behind a trusted reverse proxy (affects client-IP trust). |
| `ALLOW_PRIVATE_IPS` | `false` | Allow registering backends on loopback/private IPs. Local dev only — never in production. |

## Persistence

| Variable | Description |
|---|---|
| `DB_PATH` | SQLite file path (Docker default `/app/data/mcp-bridge.db`). Use `:memory:` for an ephemeral store. |
| `SECRET_ENCRYPTION_KEY` | Enables encrypting per-client upstream credentials at rest (AES-256-GCM). Base64 32 bytes, or any string (hashed to 32 bytes). |

## Feature flags & integrations

| Variable | Description |
|---|---|
| `ENABLE_SEARCH_TOOL` | Toggle the synthetic `search_tools` meta-tool (default on). |
| `AUDIT_SINK_URL` | Stream every audit event to a SIEM/HTTP sink. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export a trace span per tool call (OTLP/HTTP). |
| `RATE_LIMIT_SHARED` | `true` = SQLite-backed cross-instance rate counters (HA). |
| `REGISTRY_SYNC` | `true` = reconcile the registry from SQLite across instances (HA). |

## Proxy behavior

These tune the newer per-tool proxy features (caching, load balancing, traffic capture, approvals,
synthetic monitoring). Each feature is opt-in per tool/client from the admin API; these are just the
global knobs.

| Variable | Default | Description |
|---|---|---|
| `CACHE_MAX_ENTRIES` | `10000` | Max in-memory cached tool responses (LRU-evicted). |
| `LB_TARGET_COOLDOWN_MS` | `30000` | How long a load-balanced target is skipped after a failed call. |
| `TRAFFIC_CAPTURE` | `false` | Capture per-call args + result preview for the admin traffic explorer. |
| `TRAFFIC_RETENTION_MS` | 7 days | Retention window for captured traffic before pruning. |
| `APPROVAL_WEBHOOK_URL` | — | Fire-and-forget notification when a call is queued for human approval. |
| `MONITOR_WEBHOOK_URL` | — | Notification when a synthetic monitor fails or detects schema drift. |

## Inbound JWT auth (optional)

Accept OAuth2/OIDC access tokens as an MCP credential, verified against a JWKS endpoint (RS256/ES256,
via WebCrypto — no extra dependency). Additive to `MCP_API_KEYS` and DB-managed keys; setting
`JWT_JWKS_URL` also locks the surface down (like minting a managed key).

| Variable | Description |
|---|---|
| `JWT_JWKS_URL` | JWKS endpoint. When set, MCP auth also accepts a valid RS256/ES256 JWT bearer. |
| `JWT_ISSUER` | Required `iss` claim (optional — rejected on mismatch when set). |
| `JWT_AUDIENCE` | Required `aud` claim (optional — token must list it when set). |

::: tip
Generate keys/secrets with, e.g., `openssl rand -hex 24` (API keys) or
`openssl rand -base64 32` (`SECRET_ENCRYPTION_KEY`). See `.env.example` in the repo for the
complete, commented reference — including CORS, rate-limit, and timeout tuning.
:::

Next: **[Deployment →](/guide/deployment)** · **[Security →](/guide/security)**
