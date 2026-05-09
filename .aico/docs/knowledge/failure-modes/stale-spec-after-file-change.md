---
id: failure_mode_dc2398ec42f17cd1
kind: failure_mode
source_path: stale spec after file change
title: "Stale spec after file change"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.751Z
---

# Stale spec after file change

**Path:** `stale spec after file change`  
**Kind:** `failure_mode`

> openapi.yaml is updated on disk while the server is running; the in-memory spec is not reloaded — a restart is required to reflect changes.

openapi.yaml is updated on disk while the server is running; the in-memory spec is not reloaded — a restart is required to reflect changes.



