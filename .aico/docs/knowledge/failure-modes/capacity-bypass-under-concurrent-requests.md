---
id: failure_mode_0dc8476477a8d663
kind: failure_mode
source_path: capacity bypass under concurrent requests
title: "Capacity Bypass Under Concurrent Requests"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.623Z
---

# Capacity Bypass Under Concurrent Requests

**Path:** `capacity bypass under concurrent requests`  
**Kind:** `failure_mode`

> totalSessions is read without a lock; two simultaneous initialize requests may both pass the maxSessions check before either writes to the Map, transiently exceeding the cap.

totalSessions is read without a lock; two simultaneous initialize requests may both pass the maxSessions check before either writes to the Map, transiently exceeding the cap.



