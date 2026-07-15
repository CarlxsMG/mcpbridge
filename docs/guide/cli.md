# CLI (config-as-code)

Alongside the admin UI and the raw `/admin-api`, the bridge ships a small **`gateway` CLI**
for managing configuration as a version-controlled YAML file — useful for CI/CD,
GitOps-style review of guardrail/policy changes, or just scripting bulk changes. It's a
thin wrapper around the existing `/register` and `/admin-api/config/export` +
`/admin-api/config/import` endpoints; there's no separate server-side logic to install.

No separate install step: the CLI lives at `src/cli/index.ts` and runs via the `cli`
script already in `package.json`.

```bash
bun run cli -- <command> [...flags]
```

(The `--` forwards everything after it to the CLI as its own argv, so `--flag` isn't
swallowed by `bun run`.)

## Authentication

The CLI authenticates as a **bearer-token admin API client** — the same mechanism as
scripting against `/admin-api` directly (see [`ADMIN_API_KEYS`](/guide/configuration)).
`gateway login` stores the gateway URL and token in `~/.mcpbridge/config.json`
(written with `0600` permissions — treat it like an admin password, because it is one):

```bash
bun run cli -- login --url http://localhost:3000 --token $ADMIN_API_KEY
```

Every other command reads those saved credentials; there's no per-command `--token` flag.
If you haven't logged in (or the credentials file is missing/corrupt), commands fail fast
with a message telling you to re-run `login`.

## Commands

### `login`

```bash
gateway login --url <gateway-url> --token <admin-api-key>
```

Saves the gateway URL and admin API key locally. Run this once per machine (or whenever
the token rotates).

### `pull`

```bash
gateway pull [--file gateway.yaml]
```

Fetches the live configuration from `GET /admin-api/config/export` and writes it into the
file's `config:` section. If a `gateway.yaml` already exists with a hand-authored
`servers:` list, that list is preserved untouched — `pull` never derives `servers:` from
the live gateway, only `config:`. Defaults to `gateway.yaml` in the current directory.

### `plan`

```bash
gateway plan [--file gateway.yaml]
```

Dry-run: shows what `apply` _would_ do without changing anything.

- For each entry under `servers:`, prints whether it's already registered (`=`) or would
  be newly registered (`+`).
- For `config:`, diffs the file against the live export and lists each add/change/remove.

Exits **non-zero when there's drift**, so it's CI-friendly:

```bash
gateway plan --file gateway.yaml || echo "drift detected"
```

### `apply`

```bash
gateway apply [--file gateway.yaml] [--dry-run]
```

Applies `gateway.yaml` in two phases, in this order:

1. **Registers any missing `servers:` entries** via `POST /register` (skips ones that
   already exist — idempotent).
2. **Applies `config:`** via `POST /admin-api/config/import` (guardrails, policies,
   bundles, etc.).

The order is load-bearing: `config/import` only configures _already-registered_ clients,
so a file that both registers a new server and sets guards on it in the same run depends
on servers being created first. Pass `--dry-run` to preview phase 1 without registering
anything (phase 2's import endpoint has its own `dryRun` mode, reported inline).

### `connect`

```bash
gateway connect --client <claude-desktop|cursor|windsurf|continue|generic-json> \
  --scope <client|bundle|system> [--name <clientOrBundleName>] [--out <file>]
```

Generates a ready-to-paste MCP client config (`claude_desktop_config.json`, `.cursor/mcp.json`,
Windsurf's `mcp_config.json`, Continue's `config.yaml`, or a generic JSON snippet) for one of
the serving modes, instead of hand-editing the file yourself:

- `--scope client --name petstore` — a per-client shard (`/mcp/petstore`)
- `--scope bundle --name support-agent` — a curated bundle (`/mcp-custom/support-agent`)
- `--scope system` — the `/mcp` control plane (`sys_*` gateway-management tools, **not**
  backend tools; no `--name` needed)

It checks the target actually exists (and is enabled) against the live admin API before
generating anything, so a typo'd name fails with a clear message instead of a config that
silently returns no tools. Without `--out` the snippet prints to stdout; with it, it's written
straight to the file.

## Global flags

Independent of any subcommand, `gateway` also understands:

- `help`, `-h`, `--help` — print usage and exit `0` (also the default when no command is
  given)
- `version`, `-v`, `--version` — print the CLI's version (from `package.json`) and exit `0`

## `gateway.yaml` format

```yaml
version: 1

servers:
  - name: petstore
    health_url: https://petstore3.swagger.io/
    base_url: https://petstore3.swagger.io/api/v3
    openapi_url: https://petstore3.swagger.io/api/v3/openapi.json
    include_tags: [pet]
  - name: github
    kind: mcp
    mcp_url: https://your-mcp-server.example.com/mcp
    mcp_transport: streamable-http

config:
  # Verbatim shape of GET /admin-api/config/export — normally you don't hand-write
  # this section, you `gateway pull` it and then edit.
  ...
```

- **`servers:`** is CLI-only — it's not part of the admin API's config export/import
  shape, so it's always hand-authored (or copied from a previous `pull`, which preserves
  it as-is). Each entry's `kind` (`rest` default, `mcp`, or `graphql`) determines which
  fields apply, mirroring `POST /register`'s payload — see
  [Registering backends →](/guide/registering-backends).
- **`config:`** is the byte-for-byte shape returned by `/admin-api/config/export` — the
  same export the admin UI's config-versioning screen produces. Get a starting point with
  `gateway pull`, edit it, then `gateway plan` / `gateway apply`.

## Typical workflow

```bash
bun run cli -- login --url https://bridge.example.com --token $ADMIN_API_KEY
bun run cli -- pull                    # writes gateway.yaml from the live gateway
# ...edit gateway.yaml, commit it to version control...
bun run cli -- plan                    # review drift before touching anything
bun run cli -- apply                   # register servers, then apply config
```

If `apply`'s config import fails because the file was exported from a different gateway
version, it tells you to re-run `pull` and re-apply your edits on top of the refreshed
export.
