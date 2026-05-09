---
id: failure_mode_62eb3a122db01b0d
kind: failure_mode
source_path: registry throws on register
title: "Registry Throws on Register"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.672Z
---

# Registry Throws on Register

**Path:** `registry throws on register`  
**Kind:** `failure_mode`

> registry.register() throws (e.g. duplicate name conflict, schema violation). Caught by the outer try/catch; returns 400 VALIDATION_ERROR but tools may be partially written depending on registry impl.

registry.register() throws (e.g. duplicate name conflict, schema violation). Caught by the outer try/catch; returns 400 VALIDATION_ERROR but tools may be partially written depending on registry impl.



