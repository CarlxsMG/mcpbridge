---
id: concept_72ecc3b482197f97
kind: concept
source_path: session ttl cleanup
title: "Session TTL Cleanup"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.461Z
---

# Session TTL Cleanup

**Path:** `session ttl cleanup`  
**Kind:** `concept`

> Background interval (every 60s) that evicts sessions whose last touchSession timestamp exceeds config.sessionTtlMs, closing the transport and removing all map entries.

Background interval (every 60s) that evicts sessions whose last touchSession timestamp exceeds config.sessionTtlMs, closing the transport and removing all map entries.
## Aliases

- `zombie session cleanup`
- `sessionActivity`
- `cleanupTimer`




