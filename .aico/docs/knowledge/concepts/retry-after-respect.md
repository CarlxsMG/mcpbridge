---
id: concept_3e85c2e91838d468
kind: concept
source_path: retry-after respect
title: "Retry-After Respect"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.414Z
---

# Retry-After Respect

**Path:** `retry-after respect`  
**Kind:** `concept`

> On HTTP 429 responses, parses the Retry-After header (integer seconds) and sleeps up to 30 seconds before the next attempt, respecting upstream rate-limit signals.

On HTTP 429 responses, parses the Retry-After header (integer seconds) and sleeps up to 30 seconds before the next attempt, respecting upstream rate-limit signals.
## Aliases

- `429 handling`
- `retryAfter`




