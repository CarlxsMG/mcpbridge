# Concepts & glossary

A quick tour of the vocabulary used across these docs and the admin UI.

## The core idea

The bridge keeps a **registry** of backends and proxies every call through one uniform guard
pipeline, addressed by a stable `client__tool` identity — see
**[Architecture →](/guide/architecture)** for the full request path. The glossary below covers
the vocabulary that shows up across these docs and the admin UI.

## Glossary

| Term                  | What it means                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client** (backend)  | A registered backend — a **REST** API (tools discovered from OpenAPI) or an **MCP upstream** (`kind: "mcp"`).                                            |
| **Tool**              | A single callable operation, namespaced as `clientName__toolName`.                                                                                       |
| **Serving mode**      | How a client reaches tools: **aggregated** (`/mcp`), **per-client shard** (`/mcp/:name`), **curated bundle** (`/mcp-custom/:bundle`), or **legacy SSE**. |
| **Bundle**            | An admin-curated, cross-client subset of tools behind one endpoint.                                                                                      |
| **Guard**             | A per-tool **policy**: rate limit, timeout, circuit-breaker override, allowed-key restriction.                                                           |
| **Guardrail**         | A per-tool **content** control: input deny-rules, secret detection, prompt-injection response scanning, field redaction.                                 |
| **Circuit breaker**   | Per-tool failure protection (`closed → open → half_open`) that fails fast while a backend is unhealthy.                                                  |
| **Canary / failover** | Route some or all traffic to a validated **secondary** backend (weighted canary, or failover when the primary breaker opens).                            |
| **Consumer**          | A tenant/team/product that groups API keys and carries a monthly **quota**.                                                                              |
| **MCP API key**       | The credential a tool caller presents; can be **scoped** (to clients/tools), **elevated** (for sensitive tools), expiring, revocable. Stored hashed.     |
| **Admin user / role** | Who administers the bridge, gated by RBAC: `admin` / `operator` / `auditor` / `viewer`.                                                                  |
| **Team**              | A multi-tenancy boundary that scopes clients so tenants see only their own.                                                                              |
| **Registry**          | The live, in-memory view of clients + tools, hydrated from SQLite and health-monitored.                                                                  |
| **Audit log**         | A tamper-evident, **hash-chained** record of every admin mutation; optionally streamed to a SIEM.                                                        |
| **Leader**            | The single instance (elected via a SQLite lease) that runs background loops — alerts, schedules — in a multi-instance deployment.                        |
| **Composite tool**    | A macro that runs several tool steps as one call, each step through the full guard stack.                                                                |
| **`search_tools`**    | A synthetic meta-tool that lets a client search its own tool list.                                                                                       |

## How the pieces fit

- **Connect** a backend → its tools enter the registry ([Registering backends](/guide/registering-backends)).
- **Curate** what a client sees with serving modes and bundles.
- **Govern** each tool with guards, guardrails and access control.
- **Operate** with health checks, metrics, alerts, audit — and [scale out](/guide/scaling) when you need to.

See the **[Architecture →](/guide/architecture)** for the request path, or the
**[API reference →](/guide/api-reference)** for the endpoints.
