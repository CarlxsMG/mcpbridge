---
id: failure_mode_f558fd26eef4730c
kind: failure_mode
source_path: missing vary header
title: "Missing Vary Header"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.768Z
---

# Missing Vary Header

**Path:** `missing vary header`  
**Kind:** `failure_mode`

> Caching proxy or CDN caches a response for one origin and serves it to another, potentially leaking or suppressing CORS headers since no `Vary: Origin` header is set.

Caching proxy or CDN caches a response for one origin and serves it to another, potentially leaking or suppressing CORS headers since no `Vary: Origin` header is set.



