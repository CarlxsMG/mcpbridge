---
id: concept_194e5d64a9563fdf
kind: concept
source_path: dos size guard
title: "DoS Size Guard"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.377Z
---

# DoS Size Guard

**Path:** `dos size guard`  
**Kind:** `concept`

> Dual check: inspects content-length header and actual text length, rejecting specs over 5 MB to prevent memory exhaustion from oversized payloads.

Dual check: inspects content-length header and actual text length, rejecting specs over 5 MB to prevent memory exhaustion from oversized payloads.
## Aliases

- `spec size limit`
- `5MB cap`




