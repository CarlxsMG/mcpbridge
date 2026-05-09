---
id: failure_mode_d1793e6cd923526e
kind: failure_mode
source_path: lastaccess not updated on recordfailure
title: "lastAccess Not Updated on recordFailure"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.741Z
---

# lastAccess Not Updated on recordFailure

**Path:** `lastaccess not updated on recordfailure`  
**Kind:** `failure_mode`

> A client that repeatedly calls recordFailure() without canRequest() (e.g. via an alternative code path) will have a stale lastAccess, causing the eviction interval to delete an actively-failing breaker.

A client that repeatedly calls recordFailure() without canRequest() (e.g. via an alternative code path) will have a stale lastAccess, causing the eviction interval to delete an actively-failing breaker.



