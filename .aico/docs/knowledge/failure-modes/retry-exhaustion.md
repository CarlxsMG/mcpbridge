---
id: failure_mode_b2e7f28e2a1160ed
kind: failure_mode
source_path: retry exhaustion
title: "Retry Exhaustion"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.722Z
---

# Retry Exhaustion

**Path:** `retry exhaustion`  
**Kind:** `failure_mode`

> All MAX_RETRIES+1 attempts for an idempotent request return retryable status codes or throw network errors. Records a circuit-breaker failure and returns the last error message.

All MAX_RETRIES+1 attempts for an idempotent request return retryable status codes or throw network errors. Records a circuit-breaker failure and returns the last error message.



