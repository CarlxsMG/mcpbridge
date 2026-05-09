---
id: pattern_8c936b95209436a3
kind: pattern
source_path: split bearer-token surfaces
title: "Split bearer-token surfaces"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.871Z
---

# Split bearer-token surfaces

**Path:** `split bearer-token surfaces`  
**Kind:** `pattern`

> Separating AdminAuth from McpAuth lets operators issue different keys for control-plane (registration/introspection) vs data-plane (MCP traffic) and rotate them independently.

Separating AdminAuth from McpAuth lets operators issue different keys for control-plane (registration/introspection) vs data-plane (MCP traffic) and rotate them independently.



