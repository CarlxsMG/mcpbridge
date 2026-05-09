---
id: file_eea00754d72c094b
kind: file
source_path: src/registry.ts
title: "Registry — MCP Client & Tool Registration Manager"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.805Z
---

# Registry — MCP Client & Tool Registration Manager

**Path:** `src/registry.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Singleton `Registry` class that manages the lifecycle of REST-backed MCP clients and their tool definitions. Maintains two Maps: `clients` (keyed by client name) and `toolIndex` (keyed by composite `clientName__toolName`), enabling O(1) tool resolution. The `register()` method enforces strict validation (name regex, HTTP method whitelist, inputSchema object type, 10 KB schema size cap, duplicate tool detection) before sanitizing descriptions and rebuilding the index. Provides lookup, listing, unregistration, and health-status mutation. Exports a module-level singleton `registry` instance.

# `src/registry.ts` — MCP Client & Tool Registration Manager

## Purpose

Provides the central registry for all REST-backed MCP clients and their tool definitions. Acts as the single source of truth for tool resolution, client health state, and MCP tool enumeration.

---

## Exports

| Export | Kind | Description |
|---|---|---|
| `registry` | `Registry` (singleton) | Module-level instance of `Registry`; imported by the rest of the system |

---

## Key Data Structures

```
clients:   Map<string, RegisteredClient>
             ↑ keyed by client name

toolIndex: Map<string, { clientName, toolName }>
             ↑ keyed by composite "clientName__toolName"
```

The double-underscore (`__`) separator forms the MCP tool namespace, flattening multi-client tool spaces into a single identifier.

---

## Key Flows

### `register(name, tools, healthUrl, ip, baseUrl, resolvedIp)`

1. **Validate client name** — must match `/^[a-z0-9][a-z0-9_-]{0,62}$/`.
2. **Validate each tool** — name format, duplicate detection (`seenToolNames` Set), HTTP method against `VALID_METHODS`, endpoint string, description string, `inputSchema` must be `{ type: "object" }`, serialized schema ≤ 10 240 bytes.
3. **Sanitize** — calls [[sanitizeToolDescription]] on `tool.description` and on every `inputSchema.properties[*].description`.
4. **Reindex** — if the client already exists, deletes its old `toolIndex` entries before overwriting.
5. **Store** — writes `RegisteredClient` into `clients` and `clientName__toolName` entries into `toolIndex`.

### `unregister(name): boolean`

Removes all `toolIndex` entries for the client then deletes from `clients`. Returns `false` if the client was not found.

### `resolveTool(mcpToolName): ResolvedTool | undefined`

O(1) lookup via `toolIndex` → verifies the referenced `client` still exists and the `tool` is still present. Returns `{ client, tool }` or `undefined`.

### `getAllMcpTools()`

Iterates all clients and tools, emitting `{ name: "client__tool", description, inputSchema }` — the shape consumed by the MCP protocol layer.

### `markStatus(name, status)`

Mutates `client.status` in-place to `"healthy"` or `"unreachable"` for health-check driven state.

---

## Edge Cases & Gotchas

- **Re-registration is idempotent in intent but replaces state**: the old tool index is cleaned up before the new set is applied, preventing stale `toolIndex` entries from lingering when a client re-registers with a changed tool list.
- **`resolveTool` double-checks**: even if `toolIndex` has an entry, both the client and the tool within it are re-verified, guarding against partial state.
- **`sanitizeToolDescription` is applied to nested property descriptions**, not just the top-level tool description — ensuring injected control characters or prompt-injection attempts in schema metadata are also cleaned.
- **`VALID_METHODS` is a `Set`** for O(1) method validation; only `GET POST PUT PATCH DELETE` are accepted — `OPTIONS`, `HEAD`, etc. are rejected.
- **`consecutive_failures`** is initialised to `0` on registration; the health-check subsystem is expected to increment it externally via [[markStatus]] or direct mutation.

---

## References

### has_failure_mode
- [inputSchema Exceeds 10 KB](../knowledge/failure-modes/inputschema-exceeds-10-kb.md)
- [Stale toolIndex After Crash](../knowledge/failure-modes/stale-toolindex-after-crash.md)
- [Invalid or Missing HTTP Method](../knowledge/failure-modes/invalid-or-missing-http-method.md)
- [resolveTool Returns undefined for Valid-Looking Name](../knowledge/failure-modes/resolvetool-returns-undefined-for-valid-looking-name.md)
- [inputSchema Not Object Type](../knowledge/failure-modes/inputschema-not-object-type.md)
- [Invalid Client or Tool Name](../knowledge/failure-modes/invalid-client-or-tool-name.md)
- [Duplicate Tool Name Within Client](../knowledge/failure-modes/duplicate-tool-name-within-client.md)

### has_pattern
- [Singleton Registry](../knowledge/patterns/singleton-registry.md)
- [Dual-Map Index](../knowledge/patterns/dual-map-index.md)
- [Re-registration Cleanup](../knowledge/patterns/re-registration-cleanup.md)
- [Validate-then-Mutate](../knowledge/patterns/validate-then-mutate.md)

### references
- [sanitizeToolDescription](../knowledge/concepts/sanitizetooldescription.md)
- [RegisteredClient](../knowledge/concepts/registeredclient.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [ResolvedTool](../knowledge/concepts/resolvedtool.md)
- [src/types.ts — Core Domain Interfaces](src--types.ts.md)
- [sanitize.ts — Tool Description Sanitization & Prompt Injection Defense](src--sanitize.ts.md)

### uses_concept
- [sanitizeToolDescription](../knowledge/concepts/sanitizetooldescription.md)
- [RegisteredClient](../knowledge/concepts/registeredclient.md)
- [markStatus](../knowledge/concepts/markstatus.md)
- [VALID_METHODS](../knowledge/concepts/valid-methods.md)
- [toolIndex](../knowledge/concepts/toolindex.md)
- [Composite Tool Name](../knowledge/concepts/composite-tool-name.md)
- [Registry](../knowledge/concepts/registry.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [ResolvedTool](../knowledge/concepts/resolvedtool.md)
- [Client Name Regex](../knowledge/concepts/client-name-regex.md)

## Backlinks

### references
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [MCP Server Factory & Tool-Change Notifier](src--mcp-server.ts.md)
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Metrics Route — Tool Call, Session & Circuit Breaker Telemetry](src--routes--metrics.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




