---
id: concept_2bb489b09c8fe601
kind: concept
source_path: breaker registry
title: "Breaker Registry"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.395Z
---

# Breaker Registry

**Path:** `breaker registry`  
**Kind:** `concept`

> Module-scoped `Map<string, CircuitBreaker>` acting as a singleton registry keyed by client name. Managed by getCircuitBreaker, removeCircuitBreaker, and the idle eviction interval.

Module-scoped `Map<string, CircuitBreaker>` acting as a singleton registry keyed by client name. Managed by getCircuitBreaker, removeCircuitBreaker, and the idle eviction interval.
## Aliases

- `breakers map`
- `circuit registry`




