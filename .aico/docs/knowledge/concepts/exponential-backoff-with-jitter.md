---
id: concept_0c6db11fe610a2a8
kind: concept
source_path: exponential backoff with jitter
title: "Exponential Backoff with Jitter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.355Z
---

# Exponential Backoff with Jitter

**Path:** `exponential backoff with jitter`  
**Kind:** `concept`

> Retry wait time calculated as BASE_DELAY * 2^(attempt-1) plus a random fraction of BASE_DELAY. Spreads retry storms across clients and avoids thundering-herd on intermittent failures.

Retry wait time calculated as BASE_DELAY * 2^(attempt-1) plus a random fraction of BASE_DELAY. Spreads retry storms across clients and avoids thundering-herd on intermittent failures.
## Aliases

- `retry delay`
- `BASE_DELAY`




