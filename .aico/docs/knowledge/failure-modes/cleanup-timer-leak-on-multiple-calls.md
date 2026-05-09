---
id: failure_mode_1bc3a03edd5a39d7
kind: failure_mode
source_path: cleanup timer leak on multiple calls
title: "Cleanup Timer Leak on Multiple Calls"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.632Z
---

# Cleanup Timer Leak on Multiple Calls

**Path:** `cleanup timer leak on multiple calls`  
**Kind:** `failure_mode`

> Calling setupTransports more than once starts a second setInterval without clearing the first; both intervals run concurrently, doubling cleanup work and leaking the handle.

Calling setupTransports more than once starts a second setInterval without clearing the first; both intervals run concurrently, doubling cleanup work and leaking the handle.



