---
id: concept_8be277ca1cceb4fe
kind: concept
source_path: lazy state transition
title: "Lazy State Transition"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.489Z
---

# Lazy State Transition

**Path:** `lazy state transition`  
**Kind:** `concept`

> The open→half_open transition is not driven by a timer callback but is detected on-demand inside canRequest() and getState(), avoiding a second setInterval per breaker.

The open→half_open transition is not driven by a timer callback but is detected on-demand inside canRequest() and getState(), avoiding a second setInterval per breaker.
## Aliases

- `lazy open-to-half-open`




