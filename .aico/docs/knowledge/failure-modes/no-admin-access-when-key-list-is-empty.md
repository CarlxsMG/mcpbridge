---
id: failure_mode_1c4d0805cdd60df1
kind: failure_mode
source_path: no admin access when key list is empty
title: "No admin access when key list is empty"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.633Z
---

# No admin access when key list is empty

**Path:** `no admin access when key list is empty`  
**Kind:** `failure_mode`

> ADMIN_API_KEYS unset with AUTH_DISABLED=false results in an empty adminApiKeys array; any request requiring admin privileges will be rejected indefinitely with no startup error.

ADMIN_API_KEYS unset with AUTH_DISABLED=false results in an empty adminApiKeys array; any request requiring admin privileges will be rejected indefinitely with no startup error.



