---
id: concept_73069e9396af817a
kind: concept
source_path: checklimit
title: "checkLimit"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.463Z
---

# checkLimit

**Path:** `checklimit`  
**Kind:** `concept`

> Core rate-limit function. Retrieves or creates a bucket, prunes stale timestamps, enforces the limit, and either appends the current timestamp and returns true or emits a 429 response and returns false.

Core rate-limit function. Retrieves or creates a bucket, prunes stale timestamps, enforces the limit, and either appends the current timestamp and returns true or emits a 429 response and returns false.



