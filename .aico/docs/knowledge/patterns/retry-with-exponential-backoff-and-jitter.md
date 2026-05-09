---
id: pattern_5d0cb7740fc8ae61
kind: pattern
source_path: retry with exponential backoff and jitter
title: "Retry with Exponential Backoff and Jitter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.847Z
---

# Retry with Exponential Backoff and Jitter

**Path:** `retry with exponential backoff and jitter`  
**Kind:** `pattern`

> Idempotent retries use base*2^n + random(base) delay to spread load on intermittent failures and avoid synchronized retry storms from multiple concurrent callers.

Idempotent retries use base*2^n + random(base) delay to spread load on intermittent failures and avoid synchronized retry storms from multiple concurrent callers.



