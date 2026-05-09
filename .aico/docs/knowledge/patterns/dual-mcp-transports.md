---
id: pattern_19fde0d82ca22654
kind: pattern
source_path: dual mcp transports
title: "Dual MCP transports"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.818Z
---

# Dual MCP transports

**Path:** `dual mcp transports`  
**Kind:** `pattern`

> Both modern Streamable HTTP (/mcp with mcp-session-id header) and legacy SSE (/sse + /messages with sessionId query) are exposed so older MCP clients keep working during migration.

Both modern Streamable HTTP (/mcp with mcp-session-id header) and legacy SSE (/sse + /messages with sessionId query) are exposed so older MCP clients keep working during migration.



