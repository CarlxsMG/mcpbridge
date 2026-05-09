---
id: dir_9b2240785d543dd8
kind: dir
source_path: src/routes
title: "src/routes — Express Route Handlers for MCP Proxy Gateway"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.616Z
---

# src/routes — Express Route Handlers for MCP Proxy Gateway

**Path:** `src/routes`  
**Kind:** `dir`  
**Model:** `sonnet`

> Defines all Express route handlers for an MCP proxy gateway across four focused modules. `docs.ts` mounts Swagger UI from an eagerly loaded OpenAPI spec. `register.ts` handles dynamic tool registration via manual tool arrays or OpenAPI URL ingestion, enforcing SSRF validation, IP pinning, and broadcasting `toolsChanged` events to live MCP clients. `introspection.ts` provides admin-authenticated CRUD over proxy clients — listing, tool manifest inspection, and graceful teardown with circuit breaker cleanup. `metrics.ts` exposes a telemetry endpoint aggregating call counts, rolling latency averages, session counts (injected via getter), and per-client circuit breaker states. Together these modules form the complete control, registration, documentation, and observability plane of the gateway.

# src/routes — Directory Rollup

## Purpose
This directory is the routing layer of an Express-based MCP proxy gateway. It is organized into four single-responsibility modules, each wiring one logical surface area of the gateway's HTTP API.

---

## Module Inventory

### `docs.ts` — API Documentation
- Mounts **Swagger UI** at `GET /docs`.
- Reads and parses `openapi.yaml` **once at startup** using ESM-compatible `import.meta.dirname` path resolution.
- Exports a single side-effectful function `docsRoutes(app)`.

### `register.ts` — Dynamic Tool Registration
- `POST /register`: accepts a manual tools array or an OpenAPI spec URL.
  - Validates both paths against **SSRF** (blocks internal targets).
  - Resolves relative URLs from the requester's IP and **pins** the backend IP for future requests.
  - Commits registration to the shared client registry.
  - Broadcasts a `toolsChanged` event to all connected MCP clients.
- `GET /register/schema`: returns a `$ref`-flattened JSON Schema for the registration payload, loaded eagerly from `openapi.yaml` at module init.

### `introspection.ts` — Client Control Plane
All routes protected by `adminAuth` middleware.
- `GET /clients`: summary list of all registered proxy clients.
- `GET /clients/:name/tools`: tool manifest for a named client.
- `DELETE /clients/:name`: full client teardown —
  - Unregisters from the client registry.
  - Aborts in-flight proxy requests.
  - Removes circuit breaker state.
  - Notifies the MCP server of tool changes.

### `metrics.ts` — Runtime Telemetry
- `GET /metrics` (admin-gated): aggregates gateway health data:
  - Total and per-error **tool call counts**.
  - Rolling **100-sample average latency** window.
  - **Active session counts** for both streamable and SSE transports, injected via `setSessionCountGetter` for decoupled transport integration.
  - Per-client **circuit breaker** states from the registry.

---

## Cross-Cutting Patterns
| Concern | Mechanism |
|---|---|
| Admin gating | `adminAuth` middleware on metrics and all introspection routes |
| OpenAPI spec loading | Eager, synchronous load at module init (`docs.ts`, `register.ts`) |
| SSRF protection | Applied to all URL inputs in `register.ts` |
| Live MCP notification | `toolsChanged` event emitted on registration and client deletion |
| Decoupled session counting | Injected getter function in `metrics.ts` avoids direct transport imports |

---

## Architectural Role
These routes collectively expose the **entire operational surface** of the proxy gateway: onboarding new backends (`register`), inspecting and removing them (`introspection`), observing runtime health (`metrics`), and presenting the API contract to developers (`docs`). No business logic lives here — each module delegates to shared registry, circuit breaker, and MCP server primitives imported from other layers.
## Domains

- `routing`
- `Express`
- `MCP`
- `API gateway`
- `observability`
- `OpenAPI`
- `admin`
- `circuit-breaker`
- `SSRF`
- `telemetry`


---

## Backlinks

### child_of
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](../files/src--routes--metrics.ts.md)
- [docs.ts — Swagger UI Route Registration](../files/src--routes--docs.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](../files/src--routes--introspection.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](../files/src--routes--register.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](src.md)




