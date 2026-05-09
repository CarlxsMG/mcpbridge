---
id: failure_mode_1d072aef2e40520b
kind: failure_mode
source_path: inputschema exceeds 10 kb
title: "inputSchema Exceeds 10 KB"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.634Z
---

# inputSchema Exceeds 10 KB

**Path:** `inputschema exceeds 10 kb`  
**Kind:** `failure_mode`

> JSON.stringify(tool.inputSchema).length > 10240. Throws during validation, preventing oversized schemas from bloating memory or MCP payloads.

JSON.stringify(tool.inputSchema).length > 10240. Throws during validation, preventing oversized schemas from bloating memory or MCP payloads.



