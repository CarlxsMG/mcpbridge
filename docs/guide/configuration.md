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

::: tip
Generate keys/secrets with, e.g., `openssl rand -hex 24` (API keys) or
`openssl rand -base64 32` (`SECRET_ENCRYPTION_KEY`). See `.env.example` in the repo for the
complete, commented reference — including CORS, rate-limit, and timeout tuning.
:::

Next: **[Deployment →](/guide/deployment)** · **[Security →](/guide/security)**
