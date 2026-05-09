---
id: concept_9410b68cdf76ddcd
kind: concept
source_path: idle eviction
title: "Idle Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.496Z
---

# Idle Eviction

**Path:** `idle eviction`  
**Kind:** `concept`

> Background setInterval that removes breakers from the registry if their lastAccess timestamp is older than 5 minutes, preventing unbounded memory growth.

Background setInterval that removes breakers from the registry if their lastAccess timestamp is older than 5 minutes, preventing unbounded memory growth.
## Aliases

- `TTL eviction`
- `BREAKER_IDLE_TTL`




