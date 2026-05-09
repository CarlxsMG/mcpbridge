---
id: concept_c9ac5e1e5809db3e
kind: concept
source_path: consecutive failure counter
title: "Consecutive Failure Counter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.539Z
---

# Consecutive Failure Counter

**Path:** `consecutive failure counter`  
**Kind:** `concept`

> Per-client integer tracking how many health checks have failed in an unbroken sequence. Reset to 0 on any successful check. Drives both unreachable promotion and auto-eviction thresholds.

Per-client integer tracking how many health checks have failed in an unbroken sequence. Reset to 0 on any successful check. Drives both unreachable promotion and auto-eviction thresholds.
## Aliases

- `consecutive_failures`




