# Configuration

MCP REST Bridge is configured with environment variables (Bun auto-loads a `.env` file in
development). The repository's **`.env.example`** is a curated, commented starter set, and the
tables below cover the settings you'll reach for most often — the exhaustive, range-validated
list is the `config` object in `src/config.ts` (validated at boot by `src/config-schema.ts`).

## First-boot & authentication

| Variable                      | Description                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_USERNAME`    | Username for the first admin user. Applied **only once**, while the users table is empty.                                                                                   |
| `BOOTSTRAP_ADMIN_PASSWORD`    | Password for that first admin (min 12 chars). Remove after the user exists.                                                                                                 |
| `ADMIN_API_KEYS`              | Comma-separated static Bearer keys for the JSON admin API (`/admin-api`, `/register`). Optional — the Vue UI uses session login.                                            |
| `MCP_API_KEYS`                | Comma-separated keys MCP clients present to call tools. Empty = no key required (combine with per-tool guards as needed).                                                   |
| `REQUIRE_MCP_AUTH`            | `true` forces the MCP data plane to fail **closed** even before a key exists (otherwise, with no keys/JWT configured, the data plane is open and a boot warning is logged). |
| `EXPOSE_DOCS_UNAUTHENTICATED` | `true` serves `/docs` (Swagger UI + full OpenAPI spec) publicly. Off by default — `/docs` is admin-authenticated.                                                           |

## Runtime & networking

| Variable                | Default                        | Description                                                                               |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `PORT`                  | `3000` (Docker) / `8790` (dev) | Backend listen port.                                                                      |
| `SESSION_COOKIE_SECURE` | `true`                         | Keep `true` in production (HTTPS). Set `false` only for local plain-HTTP dev.             |
| `NODE_ENV`              | —                              | `development` relaxes startup guards for local dev. **Never** in production.              |
| `TRUST_PROXY`           | `false`                        | Enable **only** when behind a trusted reverse proxy (affects client-IP trust).            |
| `ALLOW_PRIVATE_IPS`     | `false`                        | Allow registering backends on loopback/private IPs. Local dev only — never in production. |

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

| Variable                      | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| `ENABLE_SEARCH_TOOL`          | Toggle the synthetic `search_tools` meta-tool (default on).        |
| `AUDIT_SINK_URL`              | Stream every audit event to a SIEM/HTTP sink.                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export a trace span per tool call (OTLP/HTTP).                     |
| `RATE_LIMIT_SHARED`           | `true` = SQLite-backed cross-instance rate counters (HA).          |
| `REGISTRY_SYNC`               | `true` = reconcile the registry from SQLite across instances (HA). |

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

| Variable       | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `JWT_JWKS_URL` | JWKS endpoint. When set, MCP auth also accepts a valid RS256/ES256 JWT bearer. |
| `JWT_ISSUER`   | Required `iss` claim (optional — rejected on mismatch when set).               |
| `JWT_AUDIENCE` | Required `aud` claim (optional — token must list it when set).                 |

::: tip
Generate keys/secrets with, e.g., `openssl rand -hex 24` (API keys) or
`openssl rand -base64 32` (`SECRET_ENCRYPTION_KEY`). `.env.example` is a curated starter set;
the exhaustive list is the `config` object in `src/config.ts`.
:::

Next: **[Deployment →](/guide/deployment)** · **[Security →](/guide/security)**
