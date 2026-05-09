---
id: failure_mode_52f182328552d4bb
kind: failure_mode
source_path: browser request without origin blocked
title: "Browser Request Without Origin Blocked"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.666Z
---

# Browser Request Without Origin Blocked

**Path:** `browser request without origin blocked`  
**Kind:** `failure_mode`

> A browser sends a request with `Sec-Fetch-Site` but no `Origin` header (e.g., some same-origin navigations); middleware returns 403 unexpectedly.

A browser sends a request with `Sec-Fetch-Site` but no `Origin` header (e.g., some same-origin navigations); middleware returns 403 unexpectedly.



