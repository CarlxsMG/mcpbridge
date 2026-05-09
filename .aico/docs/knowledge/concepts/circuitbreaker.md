---
id: concept_d6389ce7296db9a6
kind: concept
source_path: circuitbreaker
title: "CircuitBreaker"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.548Z
---

# CircuitBreaker

**Path:** `circuitbreaker`  
**Kind:** `concept`

> Class encapsulating the circuit breaker state machine for a single named client. Tracks failure count, last failure timestamp, and last access time. Exposes canRequest, recordSuccess, recordFailure, getState, and getLastAccess.

Class encapsulating the circuit breaker state machine for a single named client. Tracks failure count, last failure timestamp, and last access time. Exposes canRequest, recordSuccess, recordFailure, getState, and getLastAccess.
## Aliases

- `breaker`




