---
id: failure_mode_c78796242ff8c959
kind: failure_mode
source_path: non-bearer scheme not fully enumerated
title: "Non-Bearer scheme not fully enumerated"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.737Z
---

# Non-Bearer scheme not fully enumerated

**Path:** `non-bearer scheme not fully enumerated`  
**Kind:** `failure_mode`

> Only Basic auth is tested as a non-Bearer scheme. Other malformed Authorization values (empty string, token-only without scheme) are untested and may hit different code paths.

Only Basic auth is tested as a non-Bearer scheme. Other malformed Authorization values (empty string, token-only without scheme) are untested and may hit different code paths.



