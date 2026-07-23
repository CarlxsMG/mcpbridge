# Despliegue

MCP REST Bridge es un único proceso Bun con un fichero SQLite. No hay base de datos
externa ni requisito de Kubernetes — aunque funciona bien en un orquestador de contenedores
si quieres uno.

## Docker (recomendado)

```bash
docker build -t mcpbridge .

docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<una contraseña fuerte de 12+ chars>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  mcpbridge
```

- La imagen corre en el puerto **3000** y almacena su base de datos SQLite en **`/app/data`**
  — monta un volumen ahí para que la config sobreviva a restarts.
- Un `HEALTHCHECK` pega a `/livez` (liveness — siempre 200 si el proceso responde). El
  endpoint separado `/readyz` reporta la disponibilidad del trabajo en background
  **exclusivo del líder** de esta instancia (200 solo cuando mantiene el leader lease y su
  handle de SQLite está activo) — no es una señal general de aptitud para servir requests, ya
  que el dispatch REST/MCP es stateless y corre en cada instancia. Si escalas por throughput,
  apunta tu load balancer a `/health` (o `/livez`) en su lugar; consulta [Escalado y alta
  disponibilidad →](/es/guide/scaling). Reserva el enrutado condicionado a `/readyz` para un
  setup deliberado de failover activo/pasivo. El proceso se apaga con gracia en `SIGTERM`.

Cuando se publique la primera release, las releases taggeadas (`vX.Y.Z`) también se publicarán
a GHCR en `ghcr.io/carlxsmg/mcpbridge` (ajusta el owner/repo si forkaste este
proyecto — consulta la nota al inicio del README) — entonces podrás saltarte el build local por
completo:

```bash
docker pull ghcr.io/carlxsmg/mcpbridge:latest

docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<una contraseña fuerte de 12+ chars>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  ghcr.io/carlxsmg/mcpbridge:latest
```

Las mismas env vars que el ejemplo de build local de arriba — solo cambia la imagen. Sin
`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`, el contenedor arranca con la tabla
`admin_users` vacía y sin forma de iniciar sesión.

## Docker Compose

El repo trae un `docker-compose.yml` de producción minimalista en su raíz: un único servicio
`mcp-bridge`, un volumen nombrado para la base de datos SQLite, y el endurecimiento de runtime
(`no-new-privileges`, root filesystem de solo lectura con un tmpfs en `/tmp`) que refleja el
`securityContext` del Helm chart.

Lee los secretos de un **fichero `.env` que escribes tú mismo** — **no** hagas `cp .env.example`.
Ese ejemplo es el perfil de dev local (`NODE_ENV=development`, cookies no Secure,
`ALLOW_PRIVATE_IPS=true` = guarda SSRF apagada); Compose fija `NODE_ENV=production` vía su bloque
`environment:` (que gana sobre `env_file`), así que las guardas de arranque siguen activas y una
relajación dev-only extraviada hace que la app **falle cerrada en el arranque** en vez de correr
insegura.

```bash
# Escribe secretos de producción reales — NO una copia de .env.example.
printf 'BOOTSTRAP_ADMIN_USERNAME=admin\nBOOTSTRAP_ADMIN_PASSWORD=<una contraseña fuerte de 12+ chars>\nADMIN_API_KEYS=<key1,key2>\n' > .env

docker compose up -d
```

Aún no se publica imagen de release, así que el fichero buildea desde el código local
(`build: .`); una vez exista la primera release taggeada puedes comentar `build:` y dejar que
tire la `image:` fijada desde GHCR. El propio `HEALTHCHECK` de la imagen (que pega a `/livez`) se
detecta automáticamente. La base de datos vive en el volumen nombrado `mcp-bridge-data`, así que
sobrevive a `docker compose down`/recreación.

## Kubernetes (Helm)

Un Helm chart minimalista vive en `helm/mcp-rest-bridge` — un Deployment + Service + ConfigMap,
más un Secret y un PVC opcionales. Deliberadamente **no** trae Ingress/HPA/NetworkPolicy; ponle
delante lo que tu clúster ya use para eso.

```bash
helm install my-bridge ./helm/mcp-rest-bridge \
  --set-string secretEnv.BOOTSTRAP_ADMIN_USERNAME=admin \
  --set-string secretEnv.BOOTSTRAP_ADMIN_PASSWORD='<una contraseña fuerte de 12+ chars>' \
  --set persistence.enabled=true
```

Knobs clave de `values.yaml`:

| Valor                                                                    | Default                                                           | Propósito                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `image.repository` / `image.tag`                                         | `ghcr.io/carlxsmg/mcpbridge` / `.Chart.appVersion`                | Imagen a ejecutar — apúntala a la ruta GHCR de tu propio fork si la publicas tú.                                                                                                                                   |
| `replicaCount`                                                           | `1`                                                               | Déjalo en `1` salvo que `persistence` sea `ReadWriteMany` **y** definas `REGISTRY_SYNC`/`RATE_LIMIT_SHARED` (ver [Escalado](/es/guide/scaling)) — SQLite tiene un único escritor, así que réplicas extra divergen. |
| `persistence.enabled` / `.size` / `.storageClassName` / `.existingClaim` | `false` / `1Gi`                                                   | Provisiona (o reutiliza) un PVC para el fichero SQLite en `/app/data`. Deshabilitado = un `emptyDir` que se **pierde en cada reprogramación del pod** — habilítalo para cualquier cosa real.                       |
| `env` (ConfigMap) / `secretEnv` (Secret) / `existingSecret`              | `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, …            | Entorno no sensible vs. sensible. Referencia un Secret preexistente (external-secrets/Vault) vía `existingSecret` para saltar el templating de `secretEnv`.                                                        |
| `securityContext`                                                        | non-root uid 1000, todas las caps dropped, rootfs de solo lectura | Endurecido por defecto; coincide con el usuario `bun` de la imagen.                                                                                                                                                |
| `readinessProbe.httpGet.path`                                            | `/readyz`                                                         | Gateado por el líder — solo el líder reporta ready, así que con `replicaCount > 1` cambia esto a `/livez` si quieres que cada réplica sirva tráfico (ver [Escalado](/es/guide/scaling)).                           |
| `resources`                                                              | `100m` CPU / `128Mi`–`512Mi` memoria                              | Dimensionado para un único proceso Bun + SQLite; ajústalo a tu carga, o pon `{}` para quitar límites.                                                                                                              |

El `serviceAccount` se crea con el auto-mount de token **deshabilitado** (la app nunca llama a la
API de Kubernetes); pon `serviceAccount.automount: true` solo si añades algo que de verdad
necesite acceso a la API del clúster.

## Detrás de un reverse proxy (HTTPS)

Termina TLS en tu proxy (nginx, Caddy, Traefik, un LB en la nube) y reenvía al bridge.
En producción:

- Mantén **`SESSION_COOKIE_SECURE=true`** para que la cookie de sesión admin sea
  `__Host-`/Secure.
- Define **`TRUST_PROXY`** con un número de saltos (`1` para un único reverse proxy) o una
  lista CIDR/preset (`loopback,uniquelocal`) que coincida con tu topología real de proxy —
  **nunca `true` a secas** en producción. `true` le dice a Express que confíe en _todos_ los
  saltos de `X-Forwarded-For`, así que un cliente puede simplemente anteponer una IP
  falsificada a ese header y que se acepte como su dirección real; un número de saltos hace
  que Express solo lea la IP que añadió tu propio proxy de confianza, ignorando lo que el
  cliente haya inyectado.
- Reenvía el header `X-Forwarded-Proto` para que la lógica de HSTS y secure-cookie
  funcione.

## Bun (bare metal / VM)

```bash
bun install
cd admin-ui && bun install && bun run build && cd ..   # build del admin UI una vez
bun run start                                          # o: bun src/index.ts
```

El backend sirve el admin UI buildeado desde `admin-ui/dist` en `/admin` cuando está
presente.

## Persistencia y backups

Todo el estado durable vive en la base de datos SQLite (`DB_PATH`, por defecto
`/app/data/mcp-bridge.db` en Docker). Haz backup como cualquier fichero SQLite; usa
`:memory:` solo para runs throwaway. También puedes **export/import** la configuración
completa como JSON desde la UI de admin o `/admin-api/config`.

Para un backup full-database on-demand sin tener que entrar al host, `POST /admin-api/backup`
produce un snapshot transaccionalmente consistente (SQLite `VACUUM INTO`) y lo streamea
como fichero descargable.

### Actualizar

Los cambios de schema vienen como una lista ordenada y append-only de migraciones SQL
(`src/db/migrations.ts`) que corren **automáticamente en cada arranque**, antes de que el
servidor empiece a aceptar requests. **No hay path de downgrade** — las migraciones son
solo forward e irreversibles.

Por eso:

- **Haz backup de `data/mcp-bridge.db` (o tu `DB_PATH`) antes de actualizar** a una nueva
  versión, igual que harías snapshot de cualquier base de producción antes de un cambio
  de schema. Si una migración de la nueva versión hace algo inesperado, restaurar el
  fichero pre-actualización es la única vuelta atrás — no hay rollback automatizado.
- Las migraciones corren cada una dentro de su transacción, así que un fallo a mitad de
  migración no puede dejar el schema a medias — pero _sí_ puede dejar el proceso
  negándose a arrancar hasta que se arregle el problema subyacente (p. ej. disco lleno,
  permisos).
- Puedes comprobar qué migraciones se han aplicado ya con el CLI de SQLite:

  ```bash
  sqlite3 data/mcp-bridge.db "SELECT id, name, applied_at FROM _migrations ORDER BY id;"
  ```

## Alta disponibilidad (opt-in)

Ejecuta varias instancias tras un load balancer, compartiendo una base de datos SQLite —
consulta **[Escalado y alta disponibilidad →](/es/guide/scaling)** para las flags de HA,
guía de sticky-session y las caveats alrededor de SQLite compartido.

## Observabilidad

Métricas, tracing, analytics de uso y alertas vienen en el mismo proceso — consulta
**[Observabilidad y monitorización →](/es/guide/observability)** para qué hay disponible
y cómo wirear cada uno.

Siguiente: **[Configuración →](/es/guide/configuration)** · **[Solución de problemas →](/es/guide/troubleshooting)**
