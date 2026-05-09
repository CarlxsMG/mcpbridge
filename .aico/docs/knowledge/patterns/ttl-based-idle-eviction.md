---
id: pattern_14ccc187bf85b462
kind: pattern
source_path: ttl-based idle eviction
title: "TTL-Based Idle Eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.817Z
---

# TTL-Based Idle Eviction

**Path:** `ttl-based idle eviction`  
**Kind:** `pattern`

> A single shared interval scans all breakers and evicts idle ones, bounding registry memory growth for workloads with ephemeral or rotated client names without requiring callers to explicitly clean up.

A single shared interval scans all breakers and evicts idle ones, bounding registry memory growth for workloads with ephemeral or rotated client names without requiring callers to explicitly clean up.



