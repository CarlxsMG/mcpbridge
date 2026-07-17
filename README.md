<!--
  Repo slug used across links/badges below is `aico-dot-team-code/mcpbridge`.
  If your GitHub repo is named differently, find-and-replace that slug once.
-->
<div align="center">

<img src="docs/public/favicon.svg" width="72" height="72" alt="MCP REST Bridge logo" />

# MCP REST Bridge

### Turn any REST, GraphQL, or MCP server into secure, governed AI tools.

**The self-hosted MCP gateway with a real admin UI** — OpenAPI-to-MCP auto-discovery,
per-tool guardrails, RBAC, circuit breaking. One binary. No Kubernetes.

[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/Model_Context_Protocol-compatible-00a99a)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-00a99a)](#-contributing)
[![Mutation tested with Stryker](https://img.shields.io/badge/mutation_tested-Stryker-a2c4c9)](https://stryker-mutator.io)
[![Star on GitHub](https://img.shields.io/github/stars/aico-dot-team-code/mcpbridge?style=social)](https://github.com/aico-dot-team-code/mcpbridge)

[**🎮 Live demo**](https://aico-dot-team-code.github.io/mcpbridge/demo/) ·
[**Website & Docs**](https://aico-dot-team-code.github.io/mcpbridge/) ·
[Quickstart](#-60-second-quickstart) ·
[Features](#-features) ·
[Why this vs. the alternatives](#-mcp-rest-bridge-vs-the-alternatives)

</div>

---

**MCP REST Bridge** is an open-source **MCP gateway / proxy / aggregator** for the
[Model Context Protocol](https://modelcontextprotocol.io) (negotiates the MCP protocol
version via the **official SDK**, which supports `2024-10-07` through `2025-11-25` and
defaults to `2025-03-26` when a client sends none). Point it at an OpenAPI/Swagger spec, a GraphQL endpoint, a `curl` command
or a Postman collection and it turns your API into MCP tools automatically. Register an
existing MCP server and it re-exposes it through the same governed pipeline. Every call
runs through SSRF protection, prompt-injection sanitizing,
per-tool rate limits, circuit breakers, RBAC and a tamper-evident audit log — and you
manage all of it from a **built-in admin UI**, not a pile of YAML. Tested against
**Claude Desktop**, **Cursor**, and custom MCP agents.

<div align="center">

![MCP REST Bridge admin UI — registered servers, tools and health](docs/public/screenshots/servers.png)

**▶ [Try the live demo](https://aico-dot-team-code.github.io/mcpbridge/demo/)** — the full admin UI running on mock data, no install.

</div>

## 🔌 Convert anything to MCP

Six ways to turn a backend into governed MCP tools — one `POST /register` call, then every
call runs through the same guard pipeline:

| Your backend                 | Register with             | Becomes                          |
| ---------------------------- | ------------------------- | -------------------------------- |
| REST API (OpenAPI / Swagger) | `openapi_url`             | one MCP tool per operation       |
| GraphQL API                  | `graphql_url`             | one tool per query & mutation    |
| A `curl` command             | `curl_input`              | one tool from the request        |
| Postman collection (v2.1)    | `postman_collection`      | one tool per request             |
| No spec — hand-written       | `tools[]`                 | exactly the tools you define     |
| Existing MCP server          | `kind: "mcp"` + `mcp_url` | its tools, re-exposed & governed |

See **[Registering backends →](https://aico-dot-team-code.github.io/mcpbridge/guide/registering-backends)**
for the payload of each, and **[Bundles →](https://aico-dot-team-code.github.io/mcpbridge/guide/bundles)**
to serve several backends through one endpoint.

## ✨ Why MCP REST Bridge

- **A real admin UI, not config files.** A full Vue 3 dashboard to register servers,
  curate tool bundles, set guardrails, rotate keys, watch usage and read the audit log.
- **Bidirectional in one binary.** REST, GraphQL & OpenAPI → MCP **and** MCP → MCP gateway.
  Aggregate many backends behind one curated endpoint (a bundle).
- **Tested for real, not just green.** A 330+-file backend suite, Vitest for the admin UI,
  Playwright end-to-end, and **Stryker mutation testing** that injects faults to prove the
  tests actually catch bugs.
- **Secure by default.** SSRF + DNS-rebinding protection with IP pinning, prompt-injection
  sanitizing, secret detection, and fail-closed per-tool key restrictions — built in, not a plugin.
- **Enterprise features without the enterprise weight.** RBAC, teams, audit hash-chain + SIEM,
  canary/failover, OpenTelemetry tracing, config versioning — with **no Kubernetes and no external database.**
- **Runs anywhere.** Bun single process + `bun:sqlite`. One Docker image, or `bun src/index.ts`.

## 🚀 60-second quickstart

### Docker

```bash
docker build -t mcpbridge .

export ADMIN_API_KEY=$(openssl rand -hex 24)

docker run -p 3000:3000 \
  -e NODE_ENV=development \
  -e SESSION_COOKIE_SECURE=false \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-min-12-chars \
  -e ADMIN_API_KEYS=$ADMIN_API_KEY \
  -v "$PWD/data:/app/data" \
  mcpbridge
```

Open the admin UI at **http://localhost:3000/admin** and log in with the bootstrap
credentials. `$ADMIN_API_KEY` is the Bearer token the `curl`/CLI examples below use — keep
it exported in the same shell. (`NODE_ENV=development` + `SESSION_COOKIE_SECURE=false` are
only for local HTTP — in production run behind HTTPS and drop both.)

> **Prefer not to build from source?** Once the first release is tagged, every release will
> publish a prebuilt, multi-arch, signed image to GHCR — you'll then be able to drop the
> `docker build` step and use `ghcr.io/aico-dot-team-code/mcpbridge:latest` as the image in
> `docker run`. Until then, build locally with the `docker build` above. See
> [Deployment](https://aico-dot-team-code.github.io/mcpbridge/guide/deployment).

### Bun (local dev, with hot reload)

```bash
bun install
cp .env.example .env                 # then set BOOTSTRAP_ADMIN_PASSWORD (min 12 chars)
cd admin-ui && bun install && cd ..

bun run dev:all                      # backend :8790 + admin UI :8791
# → open http://localhost:8791/admin/
```

> **Note:** dev mode intentionally uses different ports (8790/8791) than the Docker/production
> default of 3000 — high, uncommon ports so a local dev server doesn't clash with 3000 (or a
> real gateway instance) you might also have running. See [Configuration](https://aico-dot-team-code.github.io/mcpbridge/guide/configuration) for the full port reference.

> **Every `curl`, client-config, and `cli --url` example below uses `http://localhost:3000`**
> (the Docker port). On the Bun path the backend is on `:8790` instead — set
> `export BASE=http://localhost:8790` and swap `$BASE` in for `http://localhost:3000`, or just
> replace the port by hand.

### Register your first REST API (auto-discovered from OpenAPI)

From the UI: **Add server → REST**, paste an OpenAPI URL, done. Or via the API:

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "petstore",
    "health_url": "https://petstore3.swagger.io/",
    "openapi_url": "https://petstore3.swagger.io/api/v3/openapi.json"
  }'
```

### Register an existing MCP server as an upstream

```bash
curl -X POST http://localhost:3000/register \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "kind": "mcp",
    "mcp_url": "https://your-mcp-server.example.com/mcp",
    "mcp_transport": "streamable-http"
  }'
```

### Point an MCP client at the bridge

Point it at a backend shard — the `petstore` you just registered is at `/mcp/petstore`:

```json
{
  "mcpServers": {
    "petstore": { "url": "http://localhost:3000/mcp/petstore" }
  }
}
```

Serve backend tools two ways: per-client `/mcp/:name` (one backend) or a curated bundle
`/mcp-custom/:bundle` (several behind one endpoint). The `/mcp` root is the system control
plane (`sys_*` gateway-management tools), not backend tools — all over Streamable HTTP.

### CLI (config-as-code)

Prefer managing config as a reviewable YAML file instead of clicking through the UI? A
`gateway` CLI ships in-repo — no separate install, just `bun run cli -- <command>`:

```bash
bun run cli -- login --url http://localhost:3000 --token $ADMIN_API_KEY
bun run cli -- pull    # write the live config to gateway.yaml
bun run cli -- plan    # show drift vs. gateway.yaml, non-zero exit if any (CI-friendly)
bun run cli -- apply   # register servers + apply config from gateway.yaml
bun run cli -- connect --client claude-desktop --scope system   # print MCP client config to paste
```

Global flags, independent of any subcommand: `help` / `-h` / `--help` (also the default with
no command) and `version` / `-v` / `--version`, both exiting `0`.

See **[CLI docs →](https://aico-dot-team-code.github.io/mcpbridge/guide/cli)** for the full
command reference and `gateway.yaml` format.

## 🧩 Features

**Connect anything**

- OpenAPI / Swagger → MCP **auto-discovery** — point at a spec, get tools instantly
- **GraphQL → MCP** — introspect the schema, one tool per query & mutation
- **cURL / Postman import** — derive tools from a pasted `curl` command or a Postman v2.1 export
- **Manual tool definitions** when there's no spec
- MCP → MCP **gateway / aggregator** (Streamable HTTP + SSE upstreams)
- Two data-plane serving modes: per-client `/mcp/:name` and curated bundles `/mcp-custom/:bundle` (the `/mcp` root is the system control plane)

**Govern & secure**

- SSRF + DNS-rebinding protection, per-upstream **IP pinning**
- **Guardrails**: prompt-injection sanitizing, secret detection, input deny-rules
- Per-tool **rate limits, timeouts, allowed-key** restrictions + per-client **circuit breakers**
- **RBAC** (admin / operator / auditor / viewer) + **team multi-tenancy**
- **Tamper-evident audit log** (hash-chained) + SIEM streaming

**Operate with confidence**

- **Admin UI** (Vue 3): dashboard, servers, bundles, keys, usage, alerts, schedules, audit
- **CLI** (`bun run cli`) for config-as-code: `login` / `pull` / `plan` / `apply` against a `gateway.yaml`, plus `connect` to generate MCP-client configs — see [CLI docs](https://aico-dot-team-code.github.io/mcpbridge/guide/cli)
- Health monitoring + auto-eviction; **canary / failover** secondaries
- **Config versioning + rollback**, import / export
- Prometheus `/metrics` + **OpenTelemetry (OTLP)** tracing per tool call
- **Usage-anomaly / spike** alerts via webhooks
- Composite / macro tools, a `search_tools` meta-tool, and a request playground

**Runs anywhere**

- Bun single process, `bun:sqlite` storage — **no external DB, no Kubernetes**
- One Docker image, or `bun src/index.ts`

## 🔀 How it works

<p align="center">
  <img
    alt="AI clients send tool calls over MCP; the bridge runs each through SSRF, guardrails, breaker, dispatch and audit, then dispatches to your REST or MCP backends"
    src="docs/public/screenshots/how-it-works.png"
    width="860"
  />
</p>

The bridge advertises a unified tool list to any MCP client, then proxies each call to the
right backend through the full guard stack (SSRF check → guardrails → per-tool policy →
circuit breaker → dispatch → response sanitizing → audit).

## ⚖️ MCP REST Bridge vs. the alternatives

|                                              | OpenAPI→MCP CLIs | Heavy gateways (k8s) | **MCP REST Bridge** |
| -------------------------------------------- | :--------------: | :------------------: | :-----------------: |
| REST / GraphQL / OpenAPI → MCP               |        ✅        |       partial        |         ✅          |
| MCP → MCP gateway                            |        ❌        |          ✅          |         ✅          |
| Admin UI                                     |        ❌        |         some         |     ✅ Vue SPA      |
| Built-in security (SSRF, injection, secrets) |        ❌        |         some         |         ✅          |
| RBAC + audit + teams                         |        ❌        |          ✅          |         ✅          |
| Runs without Kubernetes                      |        ✅        |          ❌          |         ✅          |
| No external database                         |        ✅        |          ❌          |  ✅ (Bun + SQLite)  |

_Capabilities vary by project; this is a general positioning, not a scorecard of any single tool._

## 📚 Documentation

Full docs live on the **[project website](https://aico-dot-team-code.github.io/mcpbridge/)**:
[Getting started](https://aico-dot-team-code.github.io/mcpbridge/guide/getting-started) ·
[Features](https://aico-dot-team-code.github.io/mcpbridge/guide/features) ·
[Why MCP REST Bridge](https://aico-dot-team-code.github.io/mcpbridge/guide/why-mcp-rest-bridge)

Prefer to learn by example? The **[`examples/`](examples/)** directory has copy-and-run samples:
a `POST /register` body per registration mode, a config-as-code `gateway.yaml`, and drop-in MCP
client configs.

## 🛠️ Tech stack

[Bun](https://bun.sh) · TypeScript (strict) · Express 5 · [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) ·
`bun:sqlite` · Vue 3 + Vite (admin UI). No ORM, minimal dependencies.

## 🤝 Contributing

Contributions welcome! The bridge is covered by **several test systems, not one** — **Bun**
for the 330+-file backend suite, **Vitest** for the admin UI, **Playwright** end-to-end, and
**[Stryker](https://stryker-mutator.io) mutation testing** on top (which injects faults to
prove the tests actually catch bugs, not just execute lines). After any change:

```bash
tsc --noEmit                            # backend type-check
bun run test                            # backend tests (should be 100% green)
bun run test:e2e                        # Playwright end-to-end (e2e/)
bun run test:mutate                     # Stryker mutation testing (scope to changed files)
cd admin-ui && bun run typecheck        # admin UI type-check
cd admin-ui && bun run test             # admin UI tests (Vitest)
cd admin-ui && bun run build            # admin UI production build
```

Open an issue to discuss larger changes first. Good first issues are labelled in the tracker.
See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide.

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

<div align="center">

**Keywords:** MCP gateway · MCP proxy · MCP aggregator · Model Context Protocol ·
OpenAPI to MCP · REST to MCP · self-hosted MCP · MCP admin UI · MCP RBAC · AI tool gateway

If this project helps you, please ⭐ **[star it on GitHub](https://github.com/aico-dot-team-code/mcpbridge)** — it's the single biggest signal that helps others discover it.

</div>
