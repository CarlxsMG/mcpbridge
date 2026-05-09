---
id: concept_f9736ebf7e298775
kind: concept
source_path: three-tier rate limiting
title: "Three-tier Rate Limiting"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.583Z
---

# Three-tier Rate Limiting

**Path:** `three-tier rate limiting`  
**Kind:** `concept`

> Three independent request-rate ceilings: registration endpoint (10/window), MCP endpoints (100/window), and a global catch-all (1000/window). Each tier maps to a separate env var.

Three independent request-rate ceilings: registration endpoint (10/window), MCP endpoints (100/window), and a global catch-all (1000/window). Each tier maps to a separate env var.
## Aliases

- `rateLimitRegister`
- `rateLimitMcp`
- `rateLimitGlobal`




