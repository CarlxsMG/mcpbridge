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
- Un `HEALTHCHECK` pega a `/livez` (liveness — siempre 200 si el proceso responde); el
  endpoint separado `/readyz` reporta la disponibilidad (200 solo cuando esta instancia
  mantiene el leader lease y su handle de SQLite está activo) y es el que deben usar los load
  balancers para decidir si enrutar tráfico a una instancia. El proceso se apaga con gracia en
  `SIGTERM`.

Cuando se publique la primera release, las releases taggeadas (`vX.Y.Z`) también se publicarán
a GHCR en `ghcr.io/aico-dot-team-code/mcpbridge` (ajusta el owner/repo si forkaste este
proyecto — consulta la nota al inicio del README) — entonces podrás saltarte el build local por
completo:

```bash
docker pull ghcr.io/aico-dot-team-code/mcpbridge:latest

docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<una contraseña fuerte de 12+ chars>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  ghcr.io/aico-dot-team-code/mcpbridge:latest
```

Las mismas env vars que el ejemplo de build local de arriba — solo cambia la imagen. Sin
`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`, el contenedor arranca con la tabla
`admin_users` vacía y sin forma de iniciar sesión.

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
