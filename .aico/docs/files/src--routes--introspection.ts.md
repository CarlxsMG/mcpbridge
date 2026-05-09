---
id: file_b2ca785ae1d24255
kind: file
source_path: src/routes/introspection.ts
title: "Introspection Routes — Admin Client Management Endpoints"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.793Z
---

# Introspection Routes — Admin Client Management Endpoints

**Path:** `src/routes/introspection.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Registers three admin-authenticated Express routes for runtime introspection and management of MCP proxy clients. `GET /clients` returns a summary list of all registered clients. `GET /clients/:name/tools` returns the tool manifest for a named client. `DELETE /clients/:name` fully tears down a client: unregisters it from the registry, aborts in-flight proxy requests, removes its circuit breaker state, and notifies the MCP server of tool changes. All routes are protected by `adminAuth` middleware. Acts as the operational control plane for the proxy gateway.

# `src/routes/introspection.ts`

## Purpose
Provides the admin control-plane HTTP API for inspecting and managing registered MCP proxy clients at runtime. All endpoints require admin authentication via the `adminAuth` middleware.

## Exports

### `introspectionRoutes(app: Express): void`
Mounts three routes onto the provided Express application instance.

---

## Routes

### `GET /clients` — List All Clients
Returns a JSON array of all clients currently registered in the [[registry]]. Each entry is a projection (not the full internal model):
```json
{ "name": "...", "ip": "...", "status": "...", "tools_count": 3, "health_url": "..." }
```

### `GET /clients/:name/tools` — Get Client Tools
Returns the full tool manifest for the named client via [[registry.getClientTools]].  
**404** with `CLIENT_NOT_FOUND` if the client name is unknown.

### `DELETE /clients/:name` — Unregister a Client
Performs a coordinated teardown in four steps:
1. **Unregister** — removes the client from [[registry]] via `registry.unregister(name)`.
2. **Abort requests** — calls [[abortClientRequests]] to cancel any in-flight proxy requests to that client.
3. **Remove circuit breaker** — calls [[removeCircuitBreaker]] to clean up resilience state.
4. **Notify MCP** — calls [[notifyToolsChanged]] so downstream MCP consumers receive an updated tool list.

Returns `{ status: "unregistered", name }` on success; **404** with `CLIENT_NOT_FOUND` if the client does not exist.

---

## Key Flows

```
DELETE /clients/:name
  → registry.unregister(name)       // removes from registry
  → abortClientRequests(name)       // cancels in-flight HTTP proxies
  → removeCircuitBreaker(name)      // purges circuit breaker state
  → notifyToolsChanged()            // pushes SSE/WS update to MCP consumers
  → log("info", ...)
  → res.json({ status: "unregistered", name })
```

## Edge Cases & Gotchas
- **Partial teardown on missing client**: If `registry.unregister` returns falsy, the route returns 404 immediately — `abortClientRequests`, `removeCircuitBreaker`, and `notifyToolsChanged` are **not** called. Stale circuit breaker or in-flight request state for a non-registered client is a possible edge case if state diverges.
- **No auth on route listing itself**: The route paths (`/clients`, `/clients/:name/tools`, `/clients/:name`) are predictable; security depends entirely on `adminAuth` being correctly enforced.
- **tools_count projection**: The list endpoint returns only `tools.length`, not tool names — callers needing tool details must follow up with `GET /clients/:name/tools`.
- **Synchronous unregistration**: All teardown steps are synchronous (no awaited Promises visible), so the 200 response may be returned before async side effects (e.g. in-flight request cancellation) have fully resolved.

---

## References

### has_dep
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Unauthorized Access if adminAuth Misconfigured](../knowledge/failure-modes/unauthorized-access-if-adminauth-misconfigured.md)
- [Stale Circuit Breaker on Registry Divergence](../knowledge/failure-modes/stale-circuit-breaker-on-registry-divergence.md)
- [MCP Consumers Not Notified on Registry Error](../knowledge/failure-modes/mcp-consumers-not-notified-on-registry-error.md)
- [In-flight Requests Not Fully Cancelled Before Response](../knowledge/failure-modes/in-flight-requests-not-fully-cancelled-before-response.md)

### has_pattern
- [Coordinated Teardown](../knowledge/patterns/coordinated-teardown.md)
- [Guard-and-Return on 404](../knowledge/patterns/guard-and-return-on-404.md)
- [Centralized Route Registration](../knowledge/patterns/centralized-route-registration.md)
- [Projection over Internal Model](../knowledge/patterns/projection-over-internal-model.md)

### references
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [Logger — Structured Dual-Format Log Emitter](src--logger.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)
- [Circuit Breaker — Per-Client Fault Isolation with Idle Eviction](src--circuit-breaker.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [adminAuth](../knowledge/concepts/adminauth.md)
- [introspectionRoutes](../knowledge/concepts/introspectionroutes.md)
- [Client Registry](../knowledge/concepts/client-registry.md)
- [notifyToolsChanged](../knowledge/concepts/notifytoolschanged.md)
- [Client Teardown Sequence](../knowledge/concepts/client-teardown-sequence.md)
- [removeCircuitBreaker](../knowledge/concepts/removecircuitbreaker.md)
- [CLIENT_NOT_FOUND Error](../knowledge/concepts/client-not-found-error.md)
- [abortClientRequests](../knowledge/concepts/abortclientrequests.md)
- [Client Projection](../knowledge/concepts/client-projection.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### parent_of
- [src/routes — Express Route Handlers for MCP Proxy Gateway](../dirs/src--routes.md)




