---
id: failure_mode_afc2edc52c253672
kind: failure_mode
source_path: proxy buffering on sse get /mcp
title: "Proxy Buffering on SSE GET /mcp"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.721Z
---

# Proxy Buffering on SSE GET /mcp

**Path:** `proxy buffering on sse get /mcp`  
**Kind:** `failure_mode`

> GET /mcp sets anti-buffering headers only when a session is found. If a proxy caches the 404 response, legitimate SSE streams may be silently swallowed.

GET /mcp sets anti-buffering headers only when a session is found. If a proxy caches the 404 response, legitimate SSE streams may be silently swallowed.



