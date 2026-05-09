---
id: pattern_54e717bb56c142d0
kind: pattern
source_path: session registry with ttl eviction
title: "Session Registry with TTL Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.837Z
---

# Session Registry with TTL Eviction

**Path:** `session registry with ttl eviction`  
**Kind:** `pattern`

> Sessions stored in Maps with a parallel activity-timestamp Map; a background interval evicts stale entries. Decouples liveness tracking from request handling and prevents unbounded memory growth from zombie sessions.

Sessions stored in Maps with a parallel activity-timestamp Map; a background interval evicts stale entries. Decouples liveness tracking from request handling and prevents unbounded memory growth from zombie sessions.



