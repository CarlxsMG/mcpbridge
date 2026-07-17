# Configuración

MCP REST Bridge se configura con variables de entorno (Bun auto-carga un fichero `.env`
en desarrollo). El **`.env.example`** del repo es un conjunto inicial curado y comentado. Las
tablas de abajo cubren la configuración a la que recurrirás más a menudo; la sección
**[Ajuste avanzado](#ajuste-avanzado)** más abajo documenta los knobs operativos — timeouts,
reintentos, circuit-breaker, rate-limit y límites de capacidad — que la mayoría de despliegues
nunca tocan. Cada variable se valida por rangos en el arranque mediante `src/config-schema.ts`,
que aborta el inicio (o registra un warning, según `STRICT_CONFIG`) ante un valor fuera de rango.

## Primer arranque y autenticación

| Variable                      | Descripción                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_USERNAME`    | Username del primer usuario admin. Se aplica **solo una vez**, mientras la tabla users esté vacía.                                                                                                                                                                        |
| `BOOTSTRAP_ADMIN_PASSWORD`    | Contraseña de ese primer admin (mín 12 chars). Eliminar después de que el usuario exista.                                                                                                                                                                                 |
| `ADMIN_API_KEYS`              | Claves Bearer estáticas separadas por comas para la admin API JSON (`/admin-api`, `/register`). Opcional — la UI Vue usa login de sesión.                                                                                                                                 |
| `MCP_API_KEYS`                | Claves separadas por comas que los clientes MCP presentan para llamar tools. Vacío = no requiere key (combinar con guards por tool según necesidad).                                                                                                                      |
| `REQUIRE_MCP_AUTH`            | `true` fuerza al plano de datos MCP a fallar **cerrado** incluso antes de que exista una key (de lo contrario, sin keys/JWT configuradas, el plano de datos queda abierto y se registra un warning de arranque).                                                          |
| `EXPOSE_DOCS_UNAUTHENTICATED` | `true` sirve `/docs` (Swagger UI + spec OpenAPI completa) públicamente. Desactivado por defecto — `/docs` requiere autenticación admin.                                                                                                                                   |
| `AUTH_DISABLED`               | `true` desactiva **toda la autenticación** (admin API, MCP, sesiones). Solo desarrollo — fuera de `NODE_ENV=development` el bridge se niega a arrancar salvo que también pongas `ALLOW_UNSAFE_AUTH_DISABLED=true`. Nunca pongas ninguna de las dos en un despliegue real. |
| `ALLOW_UNSAFE_AUTH_DISABLED`  | Opt-out que permite que `AUTH_DISABLED=true` surta efecto fuera de desarrollo. Una guarda deliberada contra tiros al pie — déjala sin definir.                                                                                                                            |

## Runtime y networking

| Variable                | Default                        | Descripción                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `3000` (Docker) / `8790` (dev) | Puerto de escucha del backend.                                                                                                                                                                                                                            |
| `SESSION_COOKIE_SECURE` | `true`                         | Mantener `true` en producción (HTTPS). Poner `false` solo para dev HTTP plano local.                                                                                                                                                                      |
| `NODE_ENV`              | —                              | `development` relaja las guardas de arranque para dev local. **Nunca** en producción.                                                                                                                                                                     |
| `TRUST_PROXY`           | `false`                        | Número de saltos (p. ej. `1`) o lista CIDR/preset acorde a tu topología de reverse proxy — nunca `true` a secas, que confía en todos los saltos de `X-Forwarded-For` y permite que un cliente falsifique su IP. Ver [Despliegue →](/es/guide/deployment). |
| `ALLOW_PRIVATE_IPS`     | `false`                        | Permitir registrar backends en loopback/IPs privadas. Solo dev local — nunca en producción.                                                                                                                                                               |
| `CORS_ORIGINS`          | —                              | Orígenes separados por comas autorizados a llamar la admin API desde un navegador (CORS). Sin definir = sin acceso admin cross-origin.                                                                                                                    |
| `ALLOWED_ORIGINS`       | —                              | Orígenes separados por comas autorizados a abrir una sesión MCP (chequeo de cabecera `Origin` en el plano de datos).                                                                                                                                      |
| `ALLOWED_HOSTS`         | —                              | Valores de cabecera `Host` separados por comas que el gateway acepta, rechazando el resto — anti-DNS-rebinding para el propio gateway.                                                                                                                    |
| `STRICT_CONFIG`         | —                              | `production` convierte los warnings de validación de config en errores duros y aborta el arranque — recomendado en producción para que una mala configuración falle rápido en vez de solo registrar un warning.                                           |

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

| Variable                      | Descripción                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SEARCH_TOOL`          | Toggle de la meta-tool sintética `search_tools` (por defecto activada).                                                                                  |
| `AUDIT_SINK_URL`              | Streamea cada evento de auditoría a un sink SIEM/HTTP.                                                                                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Exporta un trace span por llamada de tool (OTLP/HTTP).                                                                                                   |
| `RATE_LIMIT_SHARED`           | `true` = contadores de rate cross-instancia respaldados por SQLite (HA).                                                                                 |
| `REGISTRY_SYNC`               | `true` = reconcilia el registry desde SQLite entre instancias (HA).                                                                                      |
| `AUTO_GATE_WRITE_METHODS`     | `true` = trata las tools DELETE/PUT como sensibles por defecto, exigiendo confirmación step-up (los overrides por tool siguen ganando). Default `false`. |

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

| Variable                       | Descripción                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_JWKS_URL`                 | Endpoint JWKS. Cuando se configura, la auth MCP también acepta un bearer JWT RS256/ES256 válido.                                  |
| `JWT_ISSUER`                   | Claim `iss` requerido (opcional — se rechaza si hay mismatch cuando se define).                                                   |
| `JWT_AUDIENCE`                 | Claim `aud` requerido — el token debe listarlo. **Obligatorio en producción cuando `JWT_JWKS_URL` está configurado** (ver aviso). |
| `ALLOW_UNSAFE_JWT_NO_AUDIENCE` | Escape hatch para usar `JWT_JWKS_URL` sin `JWT_AUDIENCE` fuera de desarrollo. Inseguro — ver aviso. Por defecto `false`.          |

::: warning El binding de audiencia es obligatorio en producción
Con `JWT_JWKS_URL` configurado pero `JWT_AUDIENCE` vacío, se acepta **cualquier** token firmado válidamente por ese JWKS sin importar la audiencia para la que se emitió — en un IdP compartido, un token emitido para otra app se convierte en una credencial válida del gateway (una concesión de privilegios cross-audience). Por eso, fuera de desarrollo, el bridge **se niega a arrancar** en esta configuración salvo que además definas `ALLOW_UNSAFE_JWT_NO_AUDIENCE=true`. En su lugar, define `JWT_AUDIENCE` con la audiencia propia del gateway.
:::

## Ajuste avanzado

Knobs operativos con defaults sensatos — rara vez necesitas cambiar ninguno, pero se documentan
aquí para que no tengas que leer el código fuente para encontrar uno. Todas las duraciones están en
milisegundos; todos los rate limits son requests-por-minuto por origen salvo que se indique. Los
valores se validan por rangos en el arranque (`src/config-schema.ts`).

### Timeouts, reintentos y límites de respuesta

| Variable                 | Default    | Propósito                                                                           |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| `TOOL_CALL_TIMEOUT_MS`   | `30000`    | Timeout por llamada de tool en el request saliente al backend.                      |
| `RETRY_MAX_ATTEMPTS`     | `2`        | Reintentos para requests idempotentes (intentos totales = este + 1). `0` desactiva. |
| `RETRY_BASE_DELAY_MS`    | `500`      | Delay base para el backoff exponencial entre reintentos.                            |
| `RETRY_AFTER_MAX_MS`     | `30000`    | Techo respetado de una cabecera `Retry-After` del upstream.                         |
| `MAX_RESPONSE_BYTES`     | `10485760` | Máximo del body de respuesta upstream (10 MiB); respuestas mayores se rechazan.     |
| `SHUTDOWN_FORCE_EXIT_MS` | `10000`    | Periodo de gracia antes de que un shutdown por `SIGTERM` fuerce la salida.          |

### Circuit breaker y health checks

| Variable                               | Default | Propósito                                                             |
| -------------------------------------- | ------- | --------------------------------------------------------------------- |
| `CIRCUIT_BREAKER_WINDOW_MS`            | `60000` | Ventana deslizante sobre la que se cuentan los fallos por tool.       |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD`    | `3`     | Fallos dentro de la ventana que abren un breaker.                     |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`     | `30000` | Cuánto espera un breaker abierto antes de un probe half-open.         |
| `CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS` | `5000`  | Timeout aplicado al único probe request en half-open.                 |
| `MAX_CONSECUTIVE_FAILURES`             | `3`     | Fallos de health-check consecutivos antes de auto-evacuar un cliente. |
| `HEALTH_CHECK_INTERVAL_MS`             | `30000` | Intervalo entre pasadas de health-check en background.                |
| `HEALTH_CHECK_TIMEOUT_MS`              | `5000`  | Timeout del health-probe por cliente.                                 |
| `HEALTH_CHECK_MAX_CONCURRENT`          | `20`    | Máximo de health checks concurrentes por batch.                       |

### Rate limiting

Los valores `*_MAX_BUCKETS_*` limitan los mapas LRU que guardan los contadores por origen —
súbelos solo si sirves a muchísimas IPs de origen distintas y ves churn de evicción de buckets.

| Variable                              | Default  | Propósito                                                        |
| ------------------------------------- | -------- | ---------------------------------------------------------------- |
| `RATE_LIMIT_MCP`                      | `100`    | Límite por sesión de llamadas al plano de datos MCP.             |
| `RATE_LIMIT_REGISTER`                 | `10`     | Límite por IP de `POST /register`.                               |
| `RATE_LIMIT_GLOBAL`                   | `1000`   | Techo global de requests por IP.                                 |
| `RATE_LIMIT_LOGIN`                    | `10`     | Límite por IP de `POST /admin-api/auth/login`.                   |
| `RATE_LIMIT_INSTALL_LINK`             | `20`     | Límite por IP de la ruta pública `GET /install/:token`.          |
| `RATE_LIMIT_CLEANUP_INTERVAL_MS`      | `300000` | Intervalo entre pasadas de limpieza de buckets del rate-limiter. |
| `RATE_LIMIT_MAX_BUCKETS_GLOBAL`       | `50000`  | Máximo de buckets LRU en el mapa del limiter global.             |
| `RATE_LIMIT_MAX_BUCKETS_MCP`          | `100000` | Máximo de buckets LRU en el mapa del limiter de sesión MCP.      |
| `RATE_LIMIT_MAX_BUCKETS_REGISTER`     | `10000`  | Máximo de buckets LRU en el mapa del limiter de register.        |
| `RATE_LIMIT_MAX_BUCKETS_TOOL`         | `20000`  | Máximo de buckets LRU en el mapa del limiter de guard por tool.  |
| `RATE_LIMIT_MAX_BUCKETS_LOGIN`        | `5000`   | Máximo de buckets LRU en el mapa del limiter de login.           |
| `RATE_LIMIT_MAX_BUCKETS_INSTALL_LINK` | `5000`   | Máximo de buckets LRU en el mapa del limiter de install-link.    |

### Capacidad y sesiones

| Variable                  | Default    | Propósito                                                           |
| ------------------------- | ---------- | ------------------------------------------------------------------- |
| `MAX_TOOLS_PER_CLIENT`    | `100`      | Máximo de tools aceptadas en un único payload de `/register`.       |
| `MAX_JSON_DEPTH`          | `32`       | Profundidad máxima de anidamiento JSON aceptada en los bodies.      |
| `MAX_SESSIONS`            | `100`      | Máximo de sesiones MCP (Streamable HTTP) en memoria concurrentes.   |
| `SESSION_TTL_MS`          | `1800000`  | TTL de inactividad de una sesión del plano de datos MCP (30 min).   |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000`  | Timeout de inactividad deslizante de una sesión **admin** (30 min). |
| `SESSION_ABSOLUTE_TTL_MS` | `43200000` | Tope absoluto de la vida de una sesión admin (12 h).                |

### Descubrimiento (OpenAPI / GraphQL)

| Variable                       | Default | Propósito                                                                |
| ------------------------------ | ------- | ------------------------------------------------------------------------ |
| `OPENAPI_DISCOVERY_TIMEOUT_MS` | `10000` | Timeout para fetch/parseo de una spec OpenAPI al registrar.              |
| `GRAPHQL_DISCOVERY_TIMEOUT_MS` | `10000` | Timeout para una query de introspección GraphQL al registrar.            |
| `GRAPHQL_MAX_TYPES`            | `2000`  | Tope de ancho en `__schema.types` durante la introspección.              |
| `GRAPHQL_SELECTION_MAX_DEPTH`  | `2`     | Tope de profundidad para selection sets auto-sintetizados.               |
| `GRAPHQL_INPUT_MAX_DEPTH`      | `3`     | Tope de profundidad al mapear tipos INPUT_OBJECT anidados a JSON Schema. |

### Proxy WebSocket

| Variable                             | Default   | Propósito                                                         |
| ------------------------------------ | --------- | ----------------------------------------------------------------- |
| `WS_PROXY_MAX_GLOBAL_CONNECTIONS`    | `500`     | Techo de conexiones WebSocket proxied concurrentes.               |
| `WS_PROXY_DEFAULT_MAX_CONNECTIONS`   | `10`      | Tope de conexiones por target por defecto (overridable).          |
| `WS_PROXY_DEFAULT_MAX_MESSAGE_BYTES` | `1048576` | Tamaño máximo de mensaje WS por defecto (1 MiB).                  |
| `WS_PROXY_DEFAULT_IDLE_TIMEOUT_MS`   | `300000`  | Timeout de inactividad por defecto antes de cerrar un WS (5 min). |
| `WS_PROXY_DIAL_TIMEOUT_MS`           | `10000`   | Timeout para dialar el WebSocket upstream.                        |
| `WS_PROXY_REVALIDATE_INTERVAL_MS`    | `60000`   | Intervalo para revalidar la IP pineada de un target.              |

### Tracing, métricas y retención de datos

| Variable                 | Default           | Propósito                                                      |
| ------------------------ | ----------------- | -------------------------------------------------------------- |
| `METRICS_ENABLED`        | `true`            | Pon `false` para desactivar el endpoint `/metrics`.            |
| `OTEL_SERVICE_NAME`      | `mcp-rest-bridge` | Atributo de recurso `service.name` en los spans exportados.    |
| `OTEL_MAX_BATCH`         | `128`             | Spans en buffer antes de forzar un flush.                      |
| `OTEL_EXPORT_TIMEOUT_MS` | `5000`            | Timeout para un POST de export OTLP.                           |
| `TRACE_STORAGE`          | `false`           | Persiste spans a SQLite para el trace viewer integrado.        |
| `TRACE_RETENTION_MS`     | `86400000`        | Retención de spans persistidos (24 h).                         |
| `USAGE_RETENTION_MS`     | `2592000000`      | Retención de filas de uso por llamada (30 días).               |
| `TRAFFIC_MAX_BODY_BYTES` | `8192`            | Máximo de chars guardados por preview de resultado de tráfico. |

### Alertas y detección de anomalías

| Variable                     | Default   | Propósito                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------------- |
| `ALERT_INTERVAL_MS`          | `30000`   | Cada cuánto el líder evalúa las reglas de alerta.                |
| `ALERT_WEBHOOK_TIMEOUT_MS`   | `5000`    | Timeout para una entrega de webhook de alerta saliente.          |
| `ALERT_ERROR_RATE_WINDOW_MS` | `300000`  | Ventana deslizante para evaluar la alerta de error-rate (5 min). |
| `ANOMALY_RECENT_WINDOW_MS`   | `300000`  | Ventana reciente para detección de picos de uso (5 min).         |
| `ANOMALY_BASELINE_WINDOW_MS` | `3600000` | Ventana de baseline para detección de picos de uso (1 h).        |

### Timeouts de integración y HA

| Variable                        | Default        | Propósito                                                                          |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `APPROVAL_WEBHOOK_TIMEOUT_MS`   | `5000`         | Timeout para un webhook de notificación de approval.                               |
| `MONITOR_WEBHOOK_TIMEOUT_MS`    | `5000`         | Timeout para un webhook de notificación de monitor.                                |
| `AUDIT_SINK_TIMEOUT_MS`         | `3000`         | Timeout para una entrega al audit-sink (`AUDIT_SINK_URL`).                         |
| `OAUTH_TOKEN_TIMEOUT_MS`        | `10000`        | Timeout para un request de token OAuth2 client-credentials saliente.               |
| `JWT_JWKS_CACHE_MS`             | `600000`       | Cuánto se cachea un JWKS fetched (10 min).                                         |
| `JWT_JWKS_TIMEOUT_MS`           | `5000`         | Timeout para un fetch de JWKS.                                                     |
| `VAULT_REQUEST_TIMEOUT_MS`      | `5000`         | Timeout para un request encrypt/decrypt de Vault Transit.                          |
| `CONTEXT_BUDGET_LLM_TIMEOUT_MS` | `15000`        | Timeout para la llamada opt-in `llm_summarize` de compresión por tool.             |
| `LEADER_LEASE_DURATION_MS`      | `15000`        | Duración del lease de elección de líder.                                           |
| `REGISTRY_SYNC_INTERVAL_MS`     | `15000`        | Intervalo entre pasadas de reconciliación del registry (requiere `REGISTRY_SYNC`). |
| `INSTANCE_ID`                   | UUID aleatorio | Identidad estable de este proceso en la contabilidad de elección de líder.         |

### Ajuste fino de CORS y logging

| Variable                     | Default | Propósito                                                            |
| ---------------------------- | ------- | -------------------------------------------------------------------- |
| `CORS_MAX_AGE_SECONDS`       | `600`   | Duración de cache del preflight (`Access-Control-Max-Age`).          |
| `CORS_ALLOW_CREDENTIALS`     | `false` | Enviar `Access-Control-Allow-Credentials` para orígenes allowlisted. |
| `ALLOW_UNSAFE_CORS_WILDCARD` | `false` | Permitir un `*` en `CORS_ORIGINS` con la auth habilitada (inseguro). |
| `LOG_FORMAT`                 | `json`  | Salida de log estructurada `json` o `text`.                          |

::: tip
Genera claves/secretos con, p. ej., `openssl rand -hex 24` (API keys) o `openssl rand -base64 32`
(`SECRET_ENCRYPTION_KEY`). `.env.example` es un conjunto inicial curado; esta página (más
**[Ajuste avanzado](#ajuste-avanzado)** arriba) documenta cada variable, y `src/config-schema.ts`
impone el rango aceptado de cada una en el arranque.
:::

Siguiente: **[Despliegue →](/es/guide/deployment)** · **[Seguridad →](/es/guide/security)**
