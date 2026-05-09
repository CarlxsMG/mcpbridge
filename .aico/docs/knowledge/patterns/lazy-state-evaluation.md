---
id: pattern_32e904c7f0c40d8a
kind: pattern
source_path: lazy state evaluation
title: "Lazy State Evaluation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.830Z
---

# Lazy State Evaluation

**Path:** `lazy state evaluation`  
**Kind:** `pattern`

> open→half_open transition is computed on access rather than via a per-breaker timer. Reduces timer overhead to O(1) regardless of breaker count; state is re-evaluated only when actually needed.

open→half_open transition is computed on access rather than via a per-breaker timer. Reduces timer overhead to O(1) regardless of breaker count; state is re-evaluated only when actually needed.



