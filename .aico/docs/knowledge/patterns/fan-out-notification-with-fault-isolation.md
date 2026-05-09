---
id: pattern_a3254a3b3b78ecde
kind: pattern
source_path: fan-out notification with fault isolation
title: "Fan-out Notification with Fault Isolation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.878Z
---

# Fan-out Notification with Fault Isolation

**Path:** `fan-out notification with fault isolation`  
**Kind:** `pattern`

> notifyToolsChanged iterates all active servers and catches per-server errors individually, so a single broken connection cannot block notifications to the rest of the pool.

notifyToolsChanged iterates all active servers and catches per-server errors individually, so a single broken connection cannot block notifications to the rest of the pool.



