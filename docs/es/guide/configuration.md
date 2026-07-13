# Configuración

MCP REST Bridge se configura con variables de entorno (Bun auto-carga un fichero `.env`
en desarrollo). El **`.env.example`** del repo es un conjunto inicial curado y comentado, y
las tablas de abajo cubren la configuración a la que recurrirás más a menudo — la lista
exhaustiva y validada por rangos es el objeto `config` en `src/config.ts` (validado en el
arranque por `src/config-schema.ts`).

## Primer arranque y autenticación

| Variable                      | Descripción                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_USERNAME`    | Username del primer usuario admin. Se aplica **solo una vez**, mientras la tabla users esté vacía.                                                                                                               |
| `BOOTSTRAP_ADMIN_PASSWORD`    | Contraseña de ese primer admin (mín 12 chars). Eliminar después de que el usuario exista.                                                                                                                        |
| `ADMIN_API_KEYS`              | Claves Bearer estáticas separadas por comas para la admin API JSON (`/admin-api`, `/register`). Opcional — la UI Vue usa login de sesión.                                                                        |
| `MCP_API_KEYS`                | Claves separadas por comas que los clientes MCP presentan para llamar tools. Vacío = no requiere key (combinar con guards por tool según necesidad).                                                             |
| `REQUIRE_MCP_AUTH`            | `true` fuerza al plano de datos MCP a fallar **cerrado** incluso antes de que exista una key (de lo contrario, sin keys/JWT configuradas, el plano de datos queda abierto y se registra un warning de arranque). |
| `EXPOSE_DOCS_UNAUTHENTICATED` | `true` sirve `/docs` (Swagger UI + spec OpenAPI completa) públicamente. Desactivado por defecto — `/docs` requiere autenticación admin.                                                                          |

## Runtime y networking

| Variable                | Default                        | Descripción                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `3000` (Docker) / `8790` (dev) | Puerto de escucha del backend.                                                                                                                                                                                                                            |
| `SESSION_COOKIE_SECURE` | `true`                         | Mantener `true` en producción (HTTPS). Poner `false` solo para dev HTTP plano local.                                                                                                                                                                      |
| `NODE_ENV`              | —                              | `development` relaja las guardas de arranque para dev local. **Nunca** en producción.                                                                                                                                                                     |
| `TRUST_PROXY`           | `false`                        | Número de saltos (p. ej. `1`) o lista CIDR/preset acorde a tu topología de reverse proxy — nunca `true` a secas, que confía en todos los saltos de `X-Forwarded-For` y permite que un cliente falsifique su IP. Ver [Despliegue →](/es/guide/deployment). |
| `ALLOW_PRIVATE_IPS`     | `false`                        | Permitir registrar backends en loopback/IPs privadas. Solo dev local — nunca en producción.                                                                                                                                                               |

## Persistencia

| Variable                | Descripción                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PATH`               | Ruta del fichero SQLite (Docker por defecto `/app/data/mcp-bridge.db`). Usa `:memory:` para un store efímero.                   |
| `SECRET_ENCRYPTION_KEY` | Habilita cifrar credenciales upstream por cliente en reposo (AES-256-GCM). Base64 32 bytes, o cualquier string (hasheada a 32). |

### Gestor de secretos externo (opcional)

Los secretos en reposo (secretos OAuth2 client-credentials, keys auto-provisionadas de
install-link MCP) pasan por un `SecretsProvider` pluggable (`src/secrets/`), no
directamente por `SECRET_ENCRYPTION_KEY`. Hay dos backends disponibles:

- **`local`** (por defecto) — el secret-box integrado de arriba. Cero infra extra; esto es
  lo que configura `SECRET_ENCRYPTION_KEY`.
- **`vault`** — el [Transit secrets engine](https://developer.hashicorp.com/vault/docs/secrets/transit)
  de HashiCorp Vault hace el encrypt/decrypt, para operadores que por política deben
  mantener el material secreto en un KMS externo. `SECRET_ENCRYPTION_KEY` se ignora en
  este modo.

| Variable                 | Default           | Descripción                                                                                     |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| `SECRETS_PROVIDER`       | `local`           | `local` o `vault`. Cualquier otro valor falla rápido al arrancar.                               |
| `VAULT_ADDR`             | —                 | Dirección del servidor Vault (p. ej. `https://vault.example.com:8200`). Requerida para `vault`. |
| `VAULT_TOKEN`            | —                 | Token Vault enviado como `X-Vault-Token`. Requerido para `vault`.                               |
| `VAULT_TRANSIT_KEY_NAME` | `mcp-rest-bridge` | Nombre de la clave Transit de Vault usada para encrypt/decrypt.                                 |

Si Vault no está accesible o devuelve un error, la operación falla con un error claro —
nunca cae silenciosamente a almacenar el secreto en plaintext.

## Feature flags e integraciones

| Variable                      | Descripción                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| `ENABLE_SEARCH_TOOL`          | Toggle de la meta-tool sintética `search_tools` (por defecto activada).  |
| `AUDIT_SINK_URL`              | Streamea cada evento de auditoría a un sink SIEM/HTTP.                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Exporta un trace span por llamada de tool (OTLP/HTTP).                   |
| `RATE_LIMIT_SHARED`           | `true` = contadores de rate cross-instancia respaldados por SQLite (HA). |
| `REGISTRY_SYNC`               | `true` = reconcilia el registry desde SQLite entre instancias (HA).      |

## Comportamiento del proxy

Estos afinan las nuevas features de proxy por tool (caching, load balancing, captura de
tráfico, approvals, monitoring sintético). Cada feature es opt-in por tool/cliente desde la
admin API; estos son solo los knobs globales.

| Variable                | Default | Descripción                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `CACHE_MAX_ENTRIES`     | `10000` | Máximo de respuestas cacheadas en memoria (evicted por LRU).               |
| `LB_TARGET_COOLDOWN_MS` | `30000` | Cuánto tiempo se salta un target balanceado tras una llamada fallida.      |
| `TRAFFIC_CAPTURE`       | `false` | Captura args + preview de resultado por llamada para el traffic explorer.  |
| `TRAFFIC_RETENTION_MS`  | 7 días  | Ventana de retención para el tráfico capturado antes de podar.             |
| `APPROVAL_WEBHOOK_URL`  | —       | Notificación fire-and-forget cuando una llamada entra en cola de approval. |
| `MONITOR_WEBHOOK_URL`   | —       | Notificación cuando un monitor sintético falla o detecta drift de schema.  |

## Auth JWT entrante (opcional)

Acepta tokens de acceso OAuth2/OIDC como credencial MCP, verificados contra un endpoint
JWKS (RS256/ES256, vía WebCrypto — sin dependencia extra). Aditivo a `MCP_API_KEYS` y a keys
gestionadas en DB; configurar `JWT_JWKS_URL` también cierra la superficie (como mintear una
key gestionada).

| Variable       | Descripción                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `JWT_JWKS_URL` | Endpoint JWKS. Cuando se configura, la auth MCP también acepta un bearer JWT RS256/ES256 válido. |
| `JWT_ISSUER`   | Claim `iss` requerido (opcional — se rechaza si hay mismatch cuando se define).                  |
| `JWT_AUDIENCE` | Claim `aud` requerido (opcional — el token debe listarlo cuando se define).                      |

::: tip
Genera claves/secretos con, p. ej., `openssl rand -hex 24` (API keys) o `openssl rand -base64 32`
(`SECRET_ENCRYPTION_KEY`). `.env.example` es un conjunto inicial curado; la lista exhaustiva es el
objeto `config` en `src/config.ts`.
:::

Siguiente: **[Despliegue →](/es/guide/deployment)** · **[Seguridad →](/es/guide/security)**
