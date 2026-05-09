---
id: concept_cd1ab8bad34e7023
kind: concept
source_path: idempotency-gated retry
title: "Idempotency-Gated Retry"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.542Z
---

# Idempotency-Gated Retry

**Path:** `idempotency-gated retry`  
**Kind:** `concept`

> Only GET, DELETE, and HEAD requests are retried (up to MAX_RETRIES=2). Non-idempotent methods fail immediately on any error to prevent duplicate side-effects.

Only GET, DELETE, and HEAD requests are retried (up to MAX_RETRIES=2). Non-idempotent methods fail immediately on any error to prevent duplicate side-effects.
## Aliases

- `isIdempotent`
- `MAX_RETRIES`




