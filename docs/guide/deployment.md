---
description: Run MCP REST Bridge in production — Docker, Compose, Helm on Kubernetes or a standalone binary behind a reverse proxy, with backups and health checks.
---

# Deployment

MCP REST Bridge is a single Bun process with a SQLite file. There's no external database and
no Kubernetes requirement — though it runs fine in a container orchestrator if you want one.

## Docker (recommended)

Tagged releases (`vX.Y.Z`) publish a multi-arch (amd64 + arm64) image to
`ghcr.io/carlxsmg/mcpbridge`, so there is nothing to build:

```bash
docker run -d --name mcpbridge -p 3000:3000 \
  -e SESSION_COOKIE_SECURE=true \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD='<a strong 12+ char password>' \
  -e MCP_API_KEYS='<key1,key2>' \
  -v mcpbridge-data:/app/data \
  ghcr.io/carlxsmg/mcpbridge:1
```

`BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD` are **optional**. Omit both and the
first boot generates an admin credential for you and prints it once — see
[First-run admin credentials](#first-run-admin-credentials) below, because "once" is literal.

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

### First-run admin credentials

On the **first** boot only — while `admin_users` is still empty — the gateway makes sure the
admin UI is reachable. What it does depends on what you set:

| `BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` | What happens on that first boot                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| both set                                 | That account is created with the password you chose (minimum 12 characters — a shorter one is refused and no account is created).   |
| **neither** set                          | A random admin credential is **generated and printed once to stdout** (username `admin`).                                          |
| only one of the two set                  | Nothing is created. Half a configuration is treated as a mistake, not as a request for a generated account — set both, or neither. |

The generated password is 24 random bytes, base64url-encoded, so it is comfortably above the
12-character floor the gateway enforces on a hand-set one. It is written to **stdout** in a
ruled banner, deliberately outside the structured logger so it cannot be lost in the boot
chatter:

```bash
docker logs mcpbridge          # Compose: docker compose logs mcp-bridge
                               # Kubernetes: kubectl logs deploy/my-bridge
```

Only the argon2id hash is stored, so **the password is never printed again** and cannot be
recovered or reissued. Every later boot sees a non-empty table, generates nothing and emits no
credential; there is no reprint flag and no password-reset route. Two consequences worth
planning for:

- **Treat first-boot output as credential-bearing.** `docker logs`, journald and any
  stdout-tailing shipper receive this password. Sign in at `/admin`, change it, and apply your
  normal log-retention policy to that boot.
- **A boot that fails a startup guard never generates a credential.** Generation runs after
  every check that can abort startup (the startup guards, `STRICT_CONFIG` validation), so a
  misconfigured launch cannot commit an admin row to your volume and then exit with the
  password gone. Fix the configuration, boot again, and you still get a banner.

#### If you missed the banner

The gateway notices this exact situation and re-logs a warning on **every** boot — naming the
recovery paths below — until that account signs in successfully for the first time. Setting
`BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD` after the fact does **not** help: they are ignored once
any admin user exists, and the gateway warns that it ignored them. Two ways back in:

1. **Use a Bearer key.** Set `ADMIN_API_KEYS` to a strong value, restart, then create a
   replacement admin with `POST /admin-api/users` using that token. The static admin Bearer is
   accepted independently of any session.
2. **Delete the unusable row.** When the generated `admin` account is the only one, removing it
   puts the next boot back in the first-run state, which generates and prints a fresh
   credential:

   ```bash
   sqlite3 data/mcp-bridge.db "DELETE FROM admin_users WHERE username = 'admin';"
   ```

   Stop the gateway first, and back the file up — see [Persistence & backups](#persistence-backups).

### Choosing a tag

Each **successful publish** pushes the full version tag plus the floating `major`,
`major.minor` and `latest` aliases; the current list is on the
[package page](https://github.com/CarlxsMG/mcpbridge/pkgs/container/mcpbridge). GHCR images
start at `1.1.2` — the `v1.1.0` and `v1.1.1` publish runs failed, so those two releases ship
binaries but no image.

The examples on this page use the floating **`:1`** major alias, which is the right default for
evaluating the gateway: it resolves to the newest 1.x image without this page naming a version
that goes stale the moment the next release ships. **For anything long-lived, pin the exact
version you tested** — a floating alias moves, so a later `docker pull` can swap the running
version out from under you. The repo's `docker-compose.yml` carries such a pin as its default
(override it with `MCPBRIDGE_VERSION`), and that one pin is bumped by the release tooling and
checked by CI rather than maintained by hand. (Forked this project? The image path follows the
repository that published it, so swap in your own owner/repo.)

### Verifying the image

Each published image is signed with **keyless cosign** and carries an SBOM plus a build
provenance attestation. There is no public key to distribute: verification checks the image
against the GitHub Actions workflow identity that built it, so a tampered or
independently-pushed image fails even if it sits at the same tag.

```bash
# The GHCR path is lowercase; the certificate identity uses the canonical repository slug.
# Verify the reference you actually deploy — swap :1 for your pinned version tag or a digest.
cosign verify ghcr.io/carlxsmg/mcpbridge:1 \
  --certificate-identity-regexp "https://github.com/CarlxsMG/mcpbridge/.github/workflows/.+" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

### Building from source

Building the image yourself is the path for contributors and for running an unreleased
`main`; the `Dockerfile` at the repo root is the same one the release workflow publishes
from. The env vars are unchanged — only the image reference differs:

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

That pulls the pinned GHCR image — set `MCPBRIDGE_VERSION` (in the environment or in `.env`)
to choose a different tag. To build from local source instead, uncomment the `build: .` line
the file keeps commented out next to `image:`, then `docker compose up -d --build`. The
image's own `HEALTHCHECK` (hitting `/livez`) is picked up automatically. The database lives
on the `mcp-bridge-data` named volume, so it survives `docker compose down`/recreation.

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
also **export/import** configuration as JSON from the admin UI or `/admin-api/config` — that
covers registered servers with their client guards and every per-tool policy, plus bundles,
alert rules, consumer quotas, schedules, guard policies, teams, custom catalog entries and
WebSocket proxy targets — but **not** users, API keys, the audit log or stored upstream
credentials. Config rollback restores that same subset; it is not a substitute for a database
backup.

For an on-demand full-database backup without shelling into the host, `POST /admin-api/backup`
produces a transactionally-consistent snapshot (SQLite `VACUUM INTO`) and streams it back as a
downloadable file.

### Durability of the newest writes

The SQLite connection runs in **WAL** journal mode with **`PRAGMA synchronous = NORMAL`**,
rather than SQLite's default `FULL`. That is a deliberate throughput trade, it applies to every
write in the database, and there is no environment variable for it — changing it is a source
change in `src/db/connection.ts`. What it does and does not cost:

- **It cannot corrupt the database.** That is the WAL guarantee, and it is why `FULL` is not
  required here: a write torn by a crash is recovered from the write-ahead log on the next open,
  so the file stays valid whatever happens to the host.
- **It can lose the last committed transaction(s) — but only if the machine goes down**, i.e. an
  OS crash or a power cut. A clean `SIGTERM`, a `docker stop`, a `SIGKILL`, or the gateway
  process itself crashing lose nothing; the data is already handed to the OS.
- **That window includes the tail of the audit log.** The
  [hash-chained audit trail](/guide/observability#audit-trail) stays internally consistent (each
  write is its own atomic transaction), but after a power cut it can be missing its newest
  entries. If your deployment treats that log as a legal record of every action, stream it
  off-box with `AUDIT_SINK_URL` — that removes the single point of loss instead of trading
  throughput for it — or raise the pragma back to `FULL` and pay the fsync.
- **Usage analytics have a second, smaller window.** `tool_call_log` rows are buffered and
  written in batches of up to 20, flushed at the end of the current event-loop turn at the
  latest. Every reader in the gateway (`/admin-api/usage`, `/admin-api/traffic`, `sys_diagnose`,
  the admin UI's Activity page) flushes before it queries, so nothing you see there is stale —
  but a `sqlite3` query run directly against the file can be up to a batch behind.

Why the trade was made: at `FULL`, every autocommit fsyncs the WAL, and that fsync sits on the
per-tool-call write path. One `tool_call_log` insert measured **630µs at `FULL` against 60µs at
`NORMAL`** — around 61% of an end-to-end loopback tool call, and the reason throughput was flat
at roughly **840 calls/s from concurrency 1 all the way to 64**: one serialized fsync on a
single JS thread, which more concurrency cannot help. The same ceiling measured **~685 calls/s**
for calls made with a consumer-attached key (whose monthly quota counter is written per call and
deliberately not batched, because it is what enforces the quota) and **300–500 calls/s on
network-attached storage**. So the pre-change ceiling scaled with the storage's fsync latency,
not with CPU — worth knowing when you size a host or reason about a throughput number you
measure yourself.

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
