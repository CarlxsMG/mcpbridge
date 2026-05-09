---
id: failure_mode_cb1d726bbf96f939
kind: failure_mode
source_path: stale circuit breaker on registry divergence
title: "Stale Circuit Breaker on Registry Divergence"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.738Z
---

# Stale Circuit Breaker on Registry Divergence

**Path:** `stale circuit breaker on registry divergence`  
**Kind:** `failure_mode`

> If registry state and circuit breaker state diverge (e.g. a client was removed outside this route), DELETE returns 404 and skips removeCircuitBreaker, leaving orphaned circuit breaker state.

If registry state and circuit breaker state diverge (e.g. a client was removed outside this route), DELETE returns 404 and skips removeCircuitBreaker, leaving orphaned circuit breaker state.



