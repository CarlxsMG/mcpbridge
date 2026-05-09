---
id: failure_mode_a31cef65d6c73d25
kind: failure_mode
source_path: non-idempotent method failure
title: "Non-Idempotent Method Failure"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.715Z
---

# Non-Idempotent Method Failure

**Path:** `non-idempotent method failure`  
**Kind:** `failure_mode`

> Any network error or non-2xx response on POST/PUT/PATCH is never retried; a single failure immediately records a circuit-breaker failure and returns isError.

Any network error or non-2xx response on POST/PUT/PATCH is never retried; a single failure immediately records a circuit-breaker failure and returns isError.



