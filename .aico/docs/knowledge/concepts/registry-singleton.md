---
id: concept_0a00ec4e5f36d861
kind: concept
source_path: registry singleton
title: "Registry Singleton"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.355Z
---

# Registry Singleton

**Path:** `registry singleton`  
**Kind:** `concept`

> Module-level singleton instance shared across all consumers. Tests access it directly and must explicitly clear state via unregister() calls in beforeEach — reimporting does not reset it.

Module-level singleton instance shared across all consumers. Tests access it directly and must explicitly clear state via unregister() calls in beforeEach — reimporting does not reset it.
## Aliases

- `registry`
- `client registry`




