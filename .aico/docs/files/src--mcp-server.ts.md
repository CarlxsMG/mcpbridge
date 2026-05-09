---
id: file_439a058a619e822a
kind: file
source_path: src/mcp-server.ts
title: "MCP Server Factory & Tool-Change Notifier"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.784Z
---

# MCP Server Factory & Tool-Change Notifier

**Path:** `src/mcp-server.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Creates and manages Model Context Protocol (MCP) server instances that act as a REST bridge. `createMcpServer` instantiates a named server with tool-list-change capability, wires `ListTools` and `CallTool` request handlers, and tracks the instance in a module-level `activeServers` Set for lifecycle management. `notifyToolsChanged` broadcasts `notifications/tools/list_changed` to every live server, enabling dynamic tool registration. Delegation to `registry` (tool enumeration) and `proxyToolCall` (execution) keeps the server thin and focused on protocol wiring only.

# `src/mcp-server.ts`

## Purpose
Provides the MCP protocol layer for the REST bridge. This module is responsible for instantiating `Server` objects from the MCP SDK, registering protocol-level request handlers, tracking active instances, and broadcasting tool-list-change notifications to all connected clients.

It intentionally contains no business logic — tool discovery is delegated to [[src/registry.ts]] and tool execution to [[src/proxy.ts]].

---

## Exports

### `createMcpServer(): Server`
Factory function that:
1. Instantiates a new `Server` with identity `{ name: "mcp-rest-bridge", version: "1.0.0" }` and the `tools.listChanged` capability flag.
2. Registers a `ListToolsRequestSchema` handler that returns `registry.getAllMcpTools()`.
3. Registers a `CallToolRequestSchema` handler that extracts `name` and `arguments` from `request.params` and delegates to `proxyToolCall(name, args ?? {})`.
4. Adds the new instance to the module-level `activeServers` Set.
5. Attaches an `onclose` hook that removes the server from `activeServers` on teardown.

### `notifyToolsChanged(): void`
Iterates `activeServers` and fires a `notifications/tools/list_changed` notification on each. Individual server failures are silently swallowed to avoid one bad connection disrupting others.

---

## Key Flows

### Tool Discovery
```
Client → ListTools request
  → ListToolsRequestSchema handler
    → registry.getAllMcpTools()
  ← { tools: [...] }
```

### Tool Invocation
```
Client → CallTool request { name, arguments }
  → CallToolRequestSchema handler
    → proxyToolCall(name, args ?? {})
  ← tool result
```

### Dynamic Tool Registration
```
External trigger → notifyToolsChanged()
  → for each activeServer:
      server.notification("notifications/tools/list_changed")
```

---

## Edge Cases & Gotchas

- **`args ?? {}`** — MCP clients may omit `arguments` entirely; the nullish coalescing guard prevents `proxyToolCall` from receiving `undefined`.
- **Silent catch in `notifyToolsChanged`** — a closed or errored server connection does not throw and does not abort notification of remaining servers. This is intentional but means callers receive no signal about partial failures.
- **Module-level `activeServers` Set** — all server instances within the same Node.js module instance share this Set. In test environments or multi-transport setups, instances accumulate until their `onclose` fires.
- **`listChanged: true` capability** — must be declared at construction time; clients that negotiate capabilities will only accept push notifications if this flag was advertised in the handshake.

---

## References

### has_dep
- [npm:@modelcontextprotocol/sdk](../knowledge/deps/npm-modelcontextprotocol-sdk.md)

### has_failure_mode
- [Silent partial notification failure](../knowledge/failure-modes/silent-partial-notification-failure.md)
- [Memory leak from unremoved servers](../knowledge/failure-modes/memory-leak-from-unremoved-servers.md)
- [Missing arguments default bypass](../knowledge/failure-modes/missing-arguments-default-bypass.md)
- [Capability negotiation mismatch](../knowledge/failure-modes/capability-negotiation-mismatch.md)

### has_pattern
- [Fan-out Notification with Fault Isolation](../knowledge/patterns/fan-out-notification-with-fault-isolation.md)
- [Thin Protocol Adapter](../knowledge/patterns/thin-protocol-adapter.md)
- [Factory Function with Lifecycle Tracking](../knowledge/patterns/factory-function-with-lifecycle-tracking.md)

### references
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### uses_concept
- [proxyToolCall](../knowledge/concepts/proxytoolcall.md)
- [activeServers](../knowledge/concepts/activeservers.md)
- [MCP Server](../knowledge/concepts/mcp-server.md)
- [ListTools handler](../knowledge/concepts/listtools-handler.md)
- [Registry](../knowledge/concepts/registry.md)
- [CallTool handler](../knowledge/concepts/calltool-handler.md)
- [Tool-list-change notification](../knowledge/concepts/tool-list-change-notification.md)

## Backlinks

### references
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)
- [MCP Transport Setup — Streamable HTTP & Legacy SSE](src--transports.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




