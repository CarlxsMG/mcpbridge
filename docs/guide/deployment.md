# Deployment

MCP REST Bridge is a single Bun process with a SQLite file. There's no external database and
no Kubernetes requirement — though it runs fine in a container orchestrator if you want one.

## Docker (recommended)

```bash
docker build -t mcpbridge .

docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<a strong 12+ char password>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  mcpbridge
```

- The image runs on port **3000** and stores its SQLite database at **`/app/data`** — mount
  a volume there so config survives restarts.
- A `HEALTHCHECK` hits `/livez` (liveness — always 200 if the process is responding). The
  separate `/readyz` endpoint reports readiness for this instance's **leader-only** background
  work (200 only when it holds the leader lease and its SQLite handle is up) — it's not a
  general request-serving signal, since REST/MCP dispatch is stateless and runs on every
  instance. When scaling out for throughput, point your load balancer at `/health` (or
  `/livez`) instead; see [Scaling & high availability →](/guide/scaling). Reserve
  `/readyz`-gated routing for a deliberate active/passive failover setup. The process shuts
  down gracefully on `SIGTERM`.

Once the first release is tagged, tagged releases (`vX.Y.Z`) will also be published to GHCR at
`ghcr.io/carlxsmg/mcpbridge` (adjust the owner/repo if you forked this project — see
the note atop the README) — you'll then be able to skip the local build entirely:

```bash
docker pull ghcr.io/carlxsmg/mcpbridge:latest

docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<a strong 12+ char password>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  ghcr.io/carlxsmg/mcpbridge:latest
```

Same env vars as the local-build example above — only the image differs. Without
`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD`, the container starts with an empty
`admin_users` table and no way to log in.

## Docker Compose

The repo ships a minimal production `docker-compose.yml` at its root: one `mcp-bridge` service,
a named volume for the SQLite database, and the runtime hardening (`no-new-privileges`, read-only
root filesystem with a `/tmp` tmpfs) that mirrors the Helm chart's `securityContext`.

It reads secrets from a **`.env` file you write yourself** — do **not** `cp .env.example`. That
example is the local-dev profile (`NODE_ENV=development`, non-Secure cookies,
`ALLOW_PRIVATE_IPS=true` = SSRF guard off); Compose pins `NODE_ENV=production` via its
`environment:` block (which wins over `env_file`), so the startup guards stay on and a stray
dev-only relaxation makes the app **fail closed at boot** rather than run insecurely.

```bash
# Write real production secrets — NOT a copy of .env.example.
printf 'BOOTSTRAP_ADMIN_USERNAME=admin\nBOOTSTRAP_ADMIN_PASSWORD=<a strong 12+ char password>\nADMIN_API_KEYS=<key1,key2>\n' > .env

docker compose up -d
```

No release image is published yet, so the file builds from local source (`build: .`); once the
first tagged release exists you can comment `build:` out and let it pull the pinned
`image:` from GHCR instead. The image's own `HEALTHCHECK` (hitting `/livez`) is picked up
automatically. The database lives on the `mcp-bridge-data` named volume, so it survives
`docker compose down`/recreation.

## Kubernetes (Helm)

A minimal Helm chart lives at `helm/mcp-rest-bridge` — a Deployment + Service + ConfigMap, plus
an optional Secret and PVC. It deliberately ships **no** Ingress/HPA/NetworkPolicy; front it with
whatever your cluster already uses for those.

```bash
helm install my-bridge ./helm/mcp-rest-bridge \
  --set-string secretEnv.BOOTSTRAP_ADMIN_USERNAME=admin \
  --set-string secretEnv.BOOTSTRAP_ADMIN_PASSWORD='<a strong 12+ char password>' \
  --set persistence.enabled=true
```

Key `values.yaml` knobs:

| Value                                                                    | Default                                                | Purpose                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository` / `image.tag`                                         | `ghcr.io/carlxsmg/mcpbridge` / `.Chart.appVersion`     | Image to run — point at your own fork's GHCR path if you publish it yourself.                                                                                                                              |
| `replicaCount`                                                           | `1`                                                    | Keep at `1` unless `persistence` is `ReadWriteMany` **and** you set `REGISTRY_SYNC`/`RATE_LIMIT_SHARED` (see [Scaling](/guide/scaling)) — SQLite has a single writer, so extra replicas otherwise diverge. |
| `persistence.enabled` / `.size` / `.storageClassName` / `.existingClaim` | `false` / `1Gi`                                        | Provision (or reuse) a PVC for the SQLite file at `/app/data`. Disabled = an `emptyDir` that is **lost on every pod reschedule** — enable for anything real.                                               |
| `env` (ConfigMap) / `secretEnv` (Secret) / `existingSecret`              | `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, … | Non-sensitive vs. sensitive environment. Reference a pre-existing Secret (external-secrets/Vault) via `existingSecret` to skip templating `secretEnv`.                                                     |
| `securityContext`                                                        | non-root uid 1000, all caps dropped, read-only rootfs  | Hardened by default; matches the `bun` user in the image.                                                                                                                                                  |
| `readinessProbe.httpGet.path`                                            | `/readyz`                                              | Leader-gated — only the leader reports ready, so with `replicaCount > 1` switch this to `/livez` if you want every replica to serve traffic (see [Scaling](/guide/scaling)).                               |
| `resources`                                                              | `100m` CPU / `128Mi`–`512Mi` memory                    | Sized for a single Bun + SQLite process; override for your own load, or set `{}` to remove limits.                                                                                                         |

The `serviceAccount` is created with token auto-mount **disabled** (the app never calls the
Kubernetes API); flip `serviceAccount.automount: true` only if you add something that genuinely
needs cluster-API access.

## Behind a reverse proxy (HTTPS)

Terminate TLS at your proxy (nginx, Caddy, Traefik, a cloud LB) and forward to the bridge.
In production:

- Keep **`SESSION_COOKIE_SECURE=true`** so the admin session cookie is `__Host-`/Secure.
- Set **`TRUST_PROXY`** to a hop count (`1` for a single reverse proxy) or a CIDR/preset list
  (`loopback,uniquelocal`) matching your actual proxy topology — **never bare `true`** in
  production. `true` tells Express to trust _every_ hop in `X-Forwarded-For`, so a client can
  simply prepend a forged IP to that header and have it accepted as their real address; a hop
  count makes Express read only the IP your own trusted proxy appended, ignoring anything the
  client injected.
- Forward the `X-Forwarded-Proto` header so HSTS and secure-cookie logic behave.

## Bun (bare metal / VM)

```bash
bun install
cd admin-ui && bun install && bun run build && cd ..   # build the admin UI once
bun run start                                          # or: bun src/index.ts
```

The backend serves the built admin UI from `admin-ui/dist` at `/admin` when present.

## Persistence & backups

All durable state lives in the SQLite database (`DB_PATH`, default `/app/data/mcp-bridge.db`
in Docker). Back it up like any SQLite file; use `:memory:` only for throwaway runs. You can
also **export/import** the full configuration as JSON from the admin UI or `/admin-api/config`.

For an on-demand full-database backup without shelling into the host, `POST /admin-api/backup`
produces a transactionally-consistent snapshot (SQLite `VACUUM INTO`) and streams it back as a
downloadable file.

### Upgrading

Schema changes ship as an ordered, append-only list of SQL migrations
(`src/db/migrations.ts`) that run **automatically on every startup**, before the server
starts accepting requests. There is **no downgrade path** — migrations are forward-only
and irreversible.

Because of that:

- **Back up `data/mcp-bridge.db` (or your `DB_PATH`) before upgrading** to a new version,
  the same way you'd snapshot any production database before a schema change. If a new
  version's migration does something unexpected, restoring the pre-upgrade file is the
  only way back — there's no automated rollback.
- Migrations run inside a transaction each, so a mid-migration failure can't leave the
  schema half-applied — but it _can_ leave the process refusing to start until the
  underlying issue (e.g. disk full, permissions) is fixed.
- You can check which migrations have already been applied with the SQLite CLI:

  ```bash
  sqlite3 data/mcp-bridge.db "SELECT id, name, applied_at FROM _migrations ORDER BY id;"
  ```

## High availability (opt-in)

Run several instances behind a load balancer, sharing one SQLite database — see
**[Scaling & high availability →](/guide/scaling)** for the HA flags, sticky-session guidance,
and the caveats around shared SQLite.

## Observability

Metrics, tracing, usage analytics and alerting all ship in the same process — see
**[Observability & monitoring →](/guide/observability)** for what's available and how to wire
each one up.

Next: **[Configuration →](/guide/configuration)** · **[Troubleshooting →](/guide/troubleshooting)**
