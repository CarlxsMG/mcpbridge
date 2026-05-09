---
id: concept_babc8dd96fd51bed
kind: concept
source_path: batch concurrency
title: "Batch Concurrency"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.529Z
---

# Batch Concurrency

**Path:** `batch concurrency`  
**Kind:** `concept`

> Health checks are grouped into slices of up to 20 clients and executed concurrently with Promise.allSettled, bounding resource usage while parallelising checks.

Health checks are grouped into slices of up to 20 clients and executed concurrently with Promise.allSettled, bounding resource usage while parallelising checks.
## Aliases

- `MAX_CONCURRENT_CHECKS`
- `checkBatch`




