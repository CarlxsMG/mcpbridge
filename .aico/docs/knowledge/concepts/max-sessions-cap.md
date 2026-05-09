---
id: concept_c434162fae1e4131
kind: concept
source_path: max sessions cap
title: "Max Sessions Cap"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.539Z
---

# Max Sessions Cap

**Path:** `max sessions cap`  
**Kind:** `concept`

> Global ceiling on combined streamable + SSE sessions. New session creation returns HTTP 503 with a JSON-RPC error when totalSessions >= maxSessions.

Global ceiling on combined streamable + SSE sessions. New session creation returns HTTP 503 with a JSON-RPC error when totalSessions >= maxSessions.
## Aliases

- `config.maxSessions`
- `capacity enforcement`




