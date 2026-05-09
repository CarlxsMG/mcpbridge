---
id: concept_1697220d15c26cdc
kind: concept
source_path: activeservers
title: "activeServers"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.375Z
---

# activeServers

**Path:** `activeservers`  
**Kind:** `concept`

> Module-level `Set<Server>` tracking all currently connected MCP server instances. Used by `notifyToolsChanged` to broadcast events and cleaned up via `onclose` hooks.

Module-level `Set<Server>` tracking all currently connected MCP server instances. Used by `notifyToolsChanged` to broadcast events and cleaned up via `onclose` hooks.
## Aliases

- `server registry`
- `live servers`




