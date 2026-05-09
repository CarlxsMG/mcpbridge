---
id: concept_05383914f194874b
kind: concept
source_path: sliding window rate limiting
title: "Sliding Window Rate Limiting"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.354Z
---

# Sliding Window Rate Limiting

**Path:** `sliding window rate limiting`  
**Kind:** `concept`

> Rate limiting strategy where the window of allowed requests moves continuously with time rather than resetting at fixed epochs. Implemented here by storing per-request timestamps and filtering those older than 60 s on each check.

Rate limiting strategy where the window of allowed requests moves continuously with time rather than resetting at fixed epochs. Implemented here by storing per-request timestamps and filtering those older than 60 s on each check.
## Aliases

- `sliding window`
- `rolling window`




