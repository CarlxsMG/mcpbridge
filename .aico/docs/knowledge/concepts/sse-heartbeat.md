---
id: concept_1ffe71af04d6d6ee
kind: concept
source_path: sse heartbeat
title: "SSE Heartbeat"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.389Z
---

# SSE Heartbeat

**Path:** `sse heartbeat`  
**Kind:** `concept`

> setInterval at 15s that writes a ':heartbeat\n\n' SSE comment to keep the connection alive through proxies and CDNs. On write failure, cleans up the session immediately.

setInterval at 15s that writes a ':heartbeat\n\n' SSE comment to keep the connection alive through proxies and CDNs. On write failure, cleans up the session immediately.
## Aliases

- `heartbeat interval`
- `:heartbeat comment`




