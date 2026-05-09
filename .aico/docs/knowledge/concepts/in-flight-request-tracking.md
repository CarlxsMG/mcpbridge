---
id: concept_7a0c911afdbd38fb
kind: concept
source_path: in-flight request tracking
title: "In-flight Request Tracking"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.473Z
---

# In-flight Request Tracking

**Path:** `in-flight request tracking`  
**Kind:** `concept`

> A Map<clientName, Set<AbortController>> that tracks every active HTTP request per client, enabling bulk cancellation via abortClientRequests() and automatic cleanup in finally blocks.

A Map<clientName, Set<AbortController>> that tracks every active HTTP request per client, enabling bulk cancellation via abortClientRequests() and automatic cleanup in finally blocks.
## Aliases

- `inflightControllers`
- `trackRequest`
- `untrackRequest`




