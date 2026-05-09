---
id: failure_mode_9a89c618857cfade
kind: failure_mode
source_path: global bucket starvation
title: "Global Bucket Starvation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.707Z
---

# Global Bucket Starvation

**Path:** `global bucket starvation`  
**Kind:** `failure_mode`

> rateLimitGlobal uses a single 'global' key; under normal multi-user traffic a low maxPerMinute starves legitimate users once any burst fills the shared bucket.

rateLimitGlobal uses a single 'global' key; under normal multi-user traffic a low maxPerMinute starves legitimate users once any burst fills the shared bucket.



