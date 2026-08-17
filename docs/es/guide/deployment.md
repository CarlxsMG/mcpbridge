---
description: Despliega MCP REST Bridge en producción — Docker, Compose, Helm en Kubernetes o un binario tras un proxy inverso, con copias de seguridad y health checks.
---

# Despliegue

MCP REST Bridge es un único proceso Bun con un fichero SQLite. No hay base de datos
externa ni requisito de Kubernetes — aunque funciona bien en un orquestador de contenedores
si quieres uno.

## Docker (recomendado)

Las releases etiquetadas (`vX.Y.Z`) publican una imagen multi-arch (amd64 + arm64) en
`ghcr.io/carlxsmg/mcpbridge`, así que no hay nada que compilar:

```bash
docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<una contraseña fuerte de 12+ chars>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  ghcr.io/carlxsmg/mcpbridge:1
```

`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD` son **opcionales**. Si no defines
ninguna de las dos, el primer arranque genera unas credenciales de administrador y las imprime
una sola vez — mira [Credenciales de administrador del primer arranque](#credenciales-de-administrador-del-primer-arranque),
porque ese «una sola vez» es literal.

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

### Credenciales de administrador del primer arranque

Solo en el **primer** arranque — mientras `admin_users` sigue vacía — el gateway se asegura de
que la UI de admin sea accesible. Lo que hace depende de lo que hayas definido:

| `BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` | Qué ocurre en ese primer arranque                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ambas definidas                          | Se crea esa cuenta con la contraseña que elegiste (mínimo 12 caracteres: una más corta se rechaza y no se crea ninguna cuenta).                        |
| **ninguna** definida                     | Se **genera** una credencial de administrador aleatoria y se **imprime una única vez por stdout** (usuario `admin`).                                   |
| solo una de las dos                      | No se crea nada. Media configuración se trata como un despiste, no como una petición de cuenta generada: define las dos, o ninguna.                    |

La contraseña generada son 24 bytes aleatorios codificados en base64url, así que queda muy por
encima del mínimo de 12 caracteres que el gateway exige cuando la pones a mano. Se escribe por
**stdout** dentro de un recuadro, a propósito fuera del logger estructurado para que no se
pierda entre el ruido del arranque:

```bash
docker logs mcpbridge          # Compose: docker compose logs mcp-bridge
                               # Kubernetes: kubectl logs deploy/my-bridge
```

Solo se guarda el hash argon2id, de modo que **la contraseña no se vuelve a imprimir nunca** y
no se puede recuperar ni reemitir. En cualquier arranque posterior la tabla ya no está vacía: no
se genera nada y no se emite ninguna credencial; no hay flag para reimprimirla ni ruta de reseteo
de contraseña. Dos consecuencias que conviene prever:

- **Trata la salida del primer arranque como material sensible.** `docker logs`, journald y
  cualquier agente que recoja stdout reciben esa contraseña. Inicia sesión en `/admin`, cámbiala y
  aplica tu política de retención de logs a ese arranque.
- **Un arranque que falla una guarda de inicio nunca genera credenciales.** La generación ocurre
  después de todas las comprobaciones que pueden abortar el arranque (las guardas de inicio, la
  validación de `STRICT_CONFIG`), así que un lanzamiento mal configurado no puede dejar una fila
  de administrador escrita en tu volumen y salir con la contraseña perdida. Corrige la
  configuración, vuelve a arrancar y el recuadro aparece igualmente.

#### Si no viste el recuadro

El gateway detecta exactamente esa situación y repite un warning en **cada** arranque — con las
vías de recuperación de abajo — hasta que esa cuenta inicia sesión con éxito por primera vez.
Definir `BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD` a posteriori **no** sirve: se ignoran en cuanto
existe cualquier usuario administrador, y el gateway avisa de que las ha ignorado. Hay dos
caminos de vuelta:

1. **Entrar con una clave Bearer.** Define `ADMIN_API_KEYS` con un valor fuerte, reinicia y crea
   un administrador de repuesto con `POST /admin-api/users` usando ese token. El Bearer estático
   de admin se acepta con independencia de cualquier sesión.
2. **Borrar la fila inservible.** Si la cuenta `admin` generada es la única que hay, eliminarla
   devuelve el siguiente arranque al estado de primer arranque, que genera e imprime unas
   credenciales nuevas:

   ```bash
   sqlite3 data/mcp-bridge.db "DELETE FROM admin_users WHERE username = 'admin';"
   ```

   Detén el gateway antes y haz una copia del fichero — mira [Persistencia y backups](#persistencia-y-backups).

### Qué tag elegir

Cada **publicación correcta** sube el tag de versión completa más los alias móviles `major`,
`major.minor` y `latest`; la lista actual está en la
[página del paquete](https://github.com/CarlxsMG/mcpbridge/pkgs/container/mcpbridge). Las
imágenes en GHCR arrancan en `1.1.2`: los workflows de publicación de `v1.1.0` y `v1.1.1`
fallaron, así que esas dos releases traen binarios pero no imagen.

Los ejemplos de esta página usan el alias móvil de major **`:1`**, que es lo razonable para
evaluar el gateway: resuelve siempre a la imagen 1.x más reciente sin que esta página tenga que
nombrar una versión que queda obsoleta en la siguiente release. **Para cualquier cosa duradera,
fija la versión exacta que hayas probado**: un alias móvil se mueve, así que un `docker pull`
posterior puede cambiarte la versión en ejecución sin avisar. El `docker-compose.yml` del repo ya
lleva una versión fijada como valor por defecto (sobreescribible con `MCPBRIDGE_VERSION`), y ese
pin lo actualiza la herramienta de release y lo comprueba CI, no una mano humana. (¿Has hecho un
fork del proyecto? La ruta de la imagen sigue al repositorio que la publicó, así que pon tu
propio owner/repo.)

### Cómo verificar la imagen

Cada imagen publicada va firmada con **cosign keyless** y lleva un SBOM y una atestación de
procedencia del build. No hay clave pública que repartir: la verificación comprueba la imagen
contra la identidad del workflow de GitHub Actions que la construyó, de modo que una imagen
manipulada o subida por otro falla aunque esté en el mismo tag.

```bash
# La ruta de GHCR va en minúsculas; la identidad del certificado usa el slug canónico del repo.
# Verifica la referencia que despliegas de verdad — cambia :1 por tu tag de versión fija o un digest.
cosign verify ghcr.io/carlxsmg/mcpbridge:1 \
  --certificate-identity-regexp "https://github.com/CarlxsMG/mcpbridge/.github/workflows/.+" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

### Compilar desde el código

Construir la imagen tú mismo es el camino para contribuir y para ejecutar un `main` sin
publicar; el `Dockerfile` de la raíz del repo es el mismo que publica el workflow de release.
Las env vars no cambian — solo la referencia a la imagen:

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

Eso tira la imagen fijada de GHCR — usa `MCPBRIDGE_VERSION` (en el entorno o en `.env`) para
elegir otro tag. Si prefieres compilar desde el código local, descomenta la línea `build: .`
que el fichero deja comentada junto a `image:` y lanza `docker compose up -d --build`. El
propio `HEALTHCHECK` de la imagen (que pega a `/livez`) se detecta automáticamente. La base de
datos vive en el volumen nombrado `mcp-bridge-data`, así que sobrevive a
`docker compose down`/recreación.

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
`:memory:` solo para runs throwaway. También puedes **export/import** configuración como JSON
desde la UI de admin o `/admin-api/config` — eso abarca los servidores registrados con sus
guardas de cliente y todas las políticas por tool, más bundles, reglas de alerta, quotas de
consumers, schedules, políticas de guardas, equipos, entradas propias del catálogo y targets
del proxy WebSocket, pero **no** usuarios, claves de API, el registro de auditoría ni las
credenciales de upstream. El rollback de config restaura ese mismo subconjunto; no sustituye a
un backup de la base de datos.

Para un backup full-database on-demand sin tener que entrar al host, `POST /admin-api/backup`
produce un snapshot transaccionalmente consistente (SQLite `VACUUM INTO`) y lo streamea
como fichero descargable.

### Durabilidad de las últimas escrituras

La conexión SQLite trabaja en modo journal **WAL** con **`PRAGMA synchronous = NORMAL`**, en
lugar del `FULL` por defecto de SQLite. Es un intercambio deliberado a favor del rendimiento,
afecta a todas las escrituras de la base de datos y no hay variable de entorno para ello:
cambiarlo es una modificación de código en `src/db/connection.ts`. Lo que cuesta y lo que no:

- **No puede corromper la base de datos.** Esa es la garantía de WAL, y es la razón de que aquí
  no haga falta `FULL`: una escritura partida por una caída se recupera del write-ahead log en la
  siguiente apertura, así que el fichero sigue siendo válido pase lo que pase en la máquina.
- **Sí puede perder la última transacción confirmada (o las últimas), pero solo si se cae la
  máquina**: un fallo del sistema operativo o un corte de corriente. Un `SIGTERM` limpio, un
  `docker stop`, un `SIGKILL` o una caída del propio proceso del gateway no pierden nada, porque
  los datos ya están entregados al sistema operativo.
- **Esa ventana incluye la cola del log de auditoría.** El
  [log encadenado por hash](/es/guide/observability#log-de-auditoria) sigue siendo internamente
  consistente (cada escritura es su propia transacción atómica), pero tras un corte de corriente
  puede faltarle las entradas más nuevas. Si tu despliegue trata ese log como registro legal de
  cada acción, mándalo fuera de la máquina con `AUDIT_SINK_URL` — eso elimina el punto único de
  pérdida en vez de canjearlo por rendimiento — o vuelve a subir el pragma a `FULL` y paga el
  fsync.
- **La analítica de uso tiene una segunda ventana, más pequeña.** Las filas de `tool_call_log` se
  acumulan en memoria y se escriben en lotes de hasta 20, volcados como muy tarde al final del
  turno actual del event loop. Todos los lectores del gateway (`/admin-api/usage`,
  `/admin-api/traffic`, `sys_diagnose`, la página Actividad de la UI) vuelcan el buffer antes de
  consultar, así que ahí nunca ves datos desactualizados; pero una consulta `sqlite3` lanzada
  directamente contra el fichero puede ir un lote por detrás.

Por qué se hizo el intercambio: con `FULL`, cada autocommit hace fsync del WAL, y ese fsync está
justo en la ruta de escritura de cada tool call. Un insert en `tool_call_log` midió **630µs con
`FULL` frente a 60µs con `NORMAL`** — alrededor del 61% de una tool call completa contra loopback,
y el motivo de que el throughput fuera plano en unas **840 llamadas/s desde concurrencia 1 hasta
64**: un único fsync serializado sobre un solo hilo JS, que más concurrencia no puede arreglar.
Ese mismo techo midió **~685 llamadas/s** en llamadas hechas con una key atada a un consumer
(cuyo contador de cuota mensual se escribe en cada llamada y a propósito no se agrupa, porque es
lo que hace cumplir la cuota) y **300–500 llamadas/s sobre almacenamiento en red**. Es decir: el
techo anterior al cambio escalaba con la latencia de fsync del almacenamiento, no con la CPU —
conviene tenerlo en cuenta al dimensionar un host o al interpretar una cifra de throughput que
midas tú.

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
