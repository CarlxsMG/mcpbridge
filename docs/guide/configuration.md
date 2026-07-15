# Configuration

MCP REST Bridge is configured with environment variables (Bun auto-loads a `.env` file in
development). The repository's **`.env.example`** is a curated, commented starter set, and the
tables below cover the settings you'll reach for most often — the exhaustive, range-validated
list is the `config` object in `src/config.ts` (validated at boot by `src/config-schema.ts`).

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

::: tip
Generate keys/secrets with, e.g., `openssl rand -hex 24` (API keys) or
`openssl rand -base64 32` (`SECRET_ENCRYPTION_KEY`). `.env.example` is a curated starter set;
the exhaustive list is the `config` object in `src/config.ts`.
:::

Next: **[Deployment →](/guide/deployment)** · **[Security →](/guide/security)**
