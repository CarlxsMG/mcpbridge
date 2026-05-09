---
id: file_fc945e908e87c6a9
kind: file
source_path: src/__tests__/registry.test.ts
title: "Registry Singleton — Unit Test Suite"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.808Z
---

# Registry Singleton — Unit Test Suite

**Path:** `src/__tests__/registry.test.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Unit tests for the `registry` singleton from `../registry.js`. Covers client and tool registration lifecycle: valid/invalid client names (lowercase, max 63 chars, no leading hyphen), tool name validation (same pattern), inputSchema 10 KB size cap, and duplicate tool detection. Verifies tool resolution via double-underscore composite keys (`clientName__toolName`), returning `undefined` for unknown keys. Tests re-registration overwrite semantics — stale tool index entries are fully replaced. Unregistration tests confirm client removal, tool index cleanup, and boolean return value. The singleton is reset between tests via a `beforeEach` hook that unregisters all clients, ensuring full isolation without module reimport.

# `src/__tests__/registry.test.ts`

## Purpose

Unit test suite for the [[../registry.js]] singleton. Exercises the full registration lifecycle: registering clients with tools, resolving tools by composite key, re-registering (overwrite semantics), and unregistering clients. Validates all input constraints enforced by the registry.

---

## Test Helpers

### `makeTool(overrides?)`
Factory returning a minimal valid [[RestToolDefinition]]:
```ts
{ name: "get-users", method: "GET", endpoint: "/users",
  description: "Returns a list of users", inputSchema: { type: "object", properties: {} } }
```
Accepts partial overrides to target specific validation paths.

### `reg(name, tools?, healthUrl?, ip?, baseUrl?, resolvedIp?)`
Thin wrapper around `registry.register(...)` with sensible defaults, reducing boilerplate in test cases.

---

## Singleton Isolation Strategy

```ts
beforeEach(() => {
  for (const client of registry.getAllClients()) {
    registry.unregister(client.name);
  }
});
```
Iterates and unregisters all clients before every test. Avoids test-order dependencies without reimporting the module (which would not reset module-level singleton state).

---

## Test Groups

### `Registry.register — valid data`
- Client appears in `getAllClients()` after registration.
- Tool index is populated; `resolveTool("svc__list-items")` returns correct `{ client, tool }`.
- Names starting with a digit (`"1svc"`) and containing hyphens/underscores (`"my-svc_v2"`) are accepted.

### `Registry.register — invalid client name`
| Input | Expected Error |
|---|---|
| `""` (empty) | `"Client name is required"` |
| Uppercase (`"MyClient"`) | `/must match/` |
| Special chars (`"my client!"`) | `/must match/` |
| Leading hyphen (`"-bad"`) | `/must match/` |
| > 63 chars | `/must match/` |

### `Registry.register — invalid tool names`
Uppercase, spaces, leading hyphen, or length > 63 all throw `/name must be lowercase/`.

### `Registry.register — inputSchema size limit`
- Schema with an 11 000-char `description` → throws `/exceeds 10KB/`.
- Schema with a 9 000-char `description` → accepted (no throw).

### `Registry.register — duplicate tool names`
Two tools sharing a name in a single `register()` call → throws `/Duplicate tool name/`.

### `Registry.resolveTool — tool index key format`
- `"payments__charge-card"` resolves to `{ client: { name: "payments" }, tool: { name: "charge-card" } }`.
- Unknown key (`"nobody__nothing"`) → `undefined`.

### `Registry.register — re-registration`
- Re-registering an existing name leaves exactly one client in `getAllClients()`.
- Old tool index entries (`svc__old-tool`) are absent; new entries (`svc__new-tool`) are present.

### `Registry.unregister`
- Removes client from `getAllClients()`.
- Removes all associated tool index entries.
- Returns `true` if client existed, `false` if not.

---

## Edge Cases & Gotchas

- **10 KB boundary untested at exact limit**: The boundary test uses 9 000 chars, not exactly 10 240 bytes. Off-by-one behaviour at the precise limit is not covered.
- **Double-underscore collision risk**: A client named `a__b` with tool `c` produces the same composite key as client `a` with tool `b__c`. The validation regex must prohibit `__` in names to prevent phantom resolution — this is not directly asserted in the suite.
- **Re-registration atomicity**: Tests implicitly rely on the registry purging all old tool index keys before inserting new ones. A partial update would cause the stale-entry test to fail.
- **Singleton vs. re-import**: Reimporting `registry` in the same process returns the same instance; only `unregister()` calls reset state.

---

## References

### has_dep
- [npm:bun:test](../knowledge/deps/npm-bun-test.md)

### has_failure_mode
- [Partial Re-registration Write](../knowledge/failure-modes/partial-re-registration-write.md)
- [Composite Key Collision via Double-Underscore in Names](../knowledge/failure-modes/composite-key-collision-via-double-underscore-in-names.md)
- [Exact 10 KB Boundary Untested](../knowledge/failure-modes/exact-10-kb-boundary-untested.md)
- [Stale Tool Index After Re-registration](../knowledge/failure-modes/stale-tool-index-after-re-registration.md)
- [Singleton State Leakage Between Tests](../knowledge/failure-modes/singleton-state-leakage-between-tests.md)

### has_pattern
- [Factory Helper with Overrides](../knowledge/patterns/factory-helper-with-overrides.md)
- [Composite Key Namespacing](../knowledge/patterns/composite-key-namespacing.md)
- [Singleton Reset via beforeEach](../knowledge/patterns/singleton-reset-via-beforeeach.md)
- [Boundary Value Testing](../knowledge/patterns/boundary-value-testing.md)

### references
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)

### uses_concept
- [Registry Singleton](../knowledge/concepts/registry-singleton.md)
- [Tool Index](../knowledge/concepts/tool-index.md)
- [Re-registration](../knowledge/concepts/re-registration.md)
- [Singleton Isolation Pattern](../knowledge/concepts/singleton-isolation-pattern.md)
- [Composite Tool Key](../knowledge/concepts/composite-tool-key.md)
- [Tool Name Validation](../knowledge/concepts/tool-name-validation.md)
- [Duplicate Tool Detection](../knowledge/concepts/duplicate-tool-detection.md)
- [Client Name Validation](../knowledge/concepts/client-name-validation.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [inputSchema Size Cap](../knowledge/concepts/inputschema-size-cap.md)

## Backlinks

### parent_of
- [src/__tests__ — Unit Test Suite](../dirs/src--__tests__.md)




