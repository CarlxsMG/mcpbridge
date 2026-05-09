---
id: file_5ffa8bacc239b58d
kind: file
source_path: src/types.ts
title: "src/types.ts — Core Domain Interfaces"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.786Z
---

# src/types.ts — Core Domain Interfaces

**Path:** `src/types.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Defines the four foundational TypeScript interfaces for a REST tool registry system. `RegistrationPayload` supports two registration modes: manual (explicit `RestToolDefinition` list) and auto-discovery (OpenAPI URL with optional tag/operation filters). `RestToolDefinition` describes a single HTTP endpoint exposed as a tool. `RegisteredClient` extends registration data with runtime state: resolved IP, health status, and failure count. `ResolvedTool` pairs a tool with its owning client, enabling dispatch. These interfaces form the shared type contract across the entire service.

# src/types.ts — Core Domain Interfaces

## Purpose
Central type contract for a REST tool registry/gateway. All interfaces here flow through registration, discovery, health-checking, and tool-dispatch subsystems. No logic lives here — pure structural definitions.

---

## Exports

### `RegistrationPayload`
Incoming payload when a client registers itself with the gateway. Supports two mutually exclusive modes:

- **Manual mode** — caller supplies `tools: RestToolDefinition[]` directly.
- **OpenAPI auto-discovery mode** — caller supplies `openapi_url`; the gateway fetches and parses the spec. Optional `include_tags` and `exclude_operations` filter which operations are imported.

`base_url` is optional at registration time (may be derived from the request origin).

### `RestToolDefinition`
Describes a single HTTP endpoint exposed as a callable tool. Fields:
- `name` — unique identifier for the tool
- `method` — one of the standard HTTP verbs (`GET | POST | PUT | PATCH | DELETE`)
- `endpoint` — relative path on the client's `base_url`
- `description` — human-readable purpose (likely surfaced to an LLM)
- `inputSchema` — JSON Schema object describing the tool's input parameters

### `RegisteredClient`
Runtime state for a successfully registered client. Extends registration data with:
- `ip` / `resolved_ip` — original and DNS-resolved IP of the client
- `status` — `"healthy"` or `"unreachable"`, updated by health-check polling
- `consecutive_failures` — counter used to gate health-status transitions

### `ResolvedTool`
Thin pairing of a `RestToolDefinition` with its owning `RegisteredClient`. Used at dispatch time so callers have full context (base URL, IP, status) alongside the tool definition.

---

## Key Flows

1. **Registration** — external client POSTs a `RegistrationPayload`; gateway validates, optionally fetches OpenAPI spec, produces a `RegisteredClient`.
2. **Health Polling** — a background process mutates `RegisteredClient.status` and `consecutive_failures`.
3. **Tool Dispatch** — tool name is resolved to a `ResolvedTool`; `client.base_url` + `tool.endpoint` are combined to form the final HTTP request.

---

## Edge Cases & Gotchas

- `tools` and `openapi_url` are both optional — no compile-time enforcement that exactly one is provided; runtime validation must guard against neither or both being supplied.
- `base_url` being optional in `RegistrationPayload` but required in `RegisteredClient` means the gateway must synthesise or reject registrations missing it.
- `inputSchema: Record<string, unknown>` is intentionally loose — no schema versioning or required fields enforced at the type level.
- `consecutive_failures` is a raw counter with no cap defined here; overflow semantics are left to the consumer.

---

## References

### has_failure_mode
- [Missing base_url at registration](../knowledge/failure-modes/missing-base-url-at-registration.md)
- [Loose inputSchema typing](../knowledge/failure-modes/loose-inputschema-typing.md)
- [Neither tools nor openapi_url provided](../knowledge/failure-modes/neither-tools-nor-openapi-url-provided.md)
- [Both tools and openapi_url provided simultaneously](../knowledge/failure-modes/both-tools-and-openapi-url-provided-simultaneously.md)
- [Unbounded consecutive_failures counter](../knowledge/failure-modes/unbounded-consecutive-failures-counter.md)

### has_pattern
- [Resolver Pairing](../knowledge/patterns/resolver-pairing.md)
- [State Envelope Pattern](../knowledge/patterns/state-envelope-pattern.md)
- [Dual-Mode Configuration via Optional Fields](../knowledge/patterns/dual-mode-configuration-via-optional-fields.md)

### references
- [RegisteredClient](../knowledge/concepts/registeredclient.md)
- [RegistrationPayload](../knowledge/concepts/registrationpayload.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [OpenAPI auto-discovery](../knowledge/concepts/openapi-auto-discovery.md)
- [ResolvedTool](../knowledge/concepts/resolvedtool.md)

### uses_concept
- [RegisteredClient](../knowledge/concepts/registeredclient.md)
- [Manual Registration Mode](../knowledge/concepts/manual-registration-mode.md)
- [OpenAPI Auto-Discovery Mode](../knowledge/concepts/openapi-auto-discovery-mode.md)
- [RegistrationPayload](../knowledge/concepts/registrationpayload.md)
- [Consecutive Failures](../knowledge/concepts/consecutive-failures.md)
- [Health Status](../knowledge/concepts/health-status.md)
- [inputSchema](../knowledge/concepts/inputschema.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [ResolvedTool](../knowledge/concepts/resolvedtool.md)

## Backlinks

### references
- [OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs](src--openapi-discovery.ts.md)
- [Registry — MCP Client & Tool Registration Manager](src--registry.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)




