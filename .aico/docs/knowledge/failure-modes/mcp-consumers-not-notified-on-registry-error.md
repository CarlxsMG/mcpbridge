---
id: failure_mode_dea1ff25c19f9ce3
kind: failure_mode
source_path: mcp consumers not notified on registry error
title: "MCP Consumers Not Notified on Registry Error"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.753Z
---

# MCP Consumers Not Notified on Registry Error

**Path:** `mcp consumers not notified on registry error`  
**Kind:** `failure_mode`

> If registry.unregister throws unexpectedly, notifyToolsChanged is never called, leaving MCP consumers with a stale tool list until the next successful operation.

If registry.unregister throws unexpectedly, notifyToolsChanged is never called, leaving MCP consumers with a stale tool list until the next successful operation.



