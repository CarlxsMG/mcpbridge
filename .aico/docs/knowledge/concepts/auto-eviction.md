---
id: concept_16faaddbdb79d387
kind: concept
source_path: auto-eviction
title: "Auto-Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.376Z
---

# Auto-Eviction

**Path:** `auto-eviction`  
**Kind:** `concept`

> When consecutive_failures reaches config.maxConsecutiveFailures the client is permanently removed from the registry via registry.unregister(), cleaning up stale entries automatically.

When consecutive_failures reaches config.maxConsecutiveFailures the client is permanently removed from the registry via registry.unregister(), cleaning up stale entries automatically.
## Aliases

- `auto-evict`
- `unregister on failure`




