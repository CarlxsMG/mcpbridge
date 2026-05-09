---
id: pattern_1059faa59fd86572
kind: pattern
source_path: circuit breaker
title: "Circuit Breaker"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.816Z
---

# Circuit Breaker

**Path:** `circuit breaker`  
**Kind:** `pattern`

> Per-client circuit breakers gate all outbound calls, fast-failing when a backend is unhealthy and using reduced half-open probe timeouts to limit blast radius during recovery.

Per-client circuit breakers gate all outbound calls, fast-failing when a backend is unhealthy and using reduced half-open probe timeouts to limit blast radius during recovery.



