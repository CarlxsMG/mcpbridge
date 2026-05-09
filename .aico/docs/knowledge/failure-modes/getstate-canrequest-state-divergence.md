---
id: failure_mode_fdd1ed2f88d054f3
kind: failure_mode
source_path: getstate / canrequest state divergence
title: "getState / canRequest State Divergence"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.772Z
---

# getState / canRequest State Divergence

**Path:** `getstate / canrequest state divergence`  
**Kind:** `failure_mode`

> External observers call getAllCircuitStates() after resetTimeoutMs has elapsed. getState() returns 'half_open' (computed, no mutation) while the internal field remains 'open' until canRequest() is called, producing inconsistent reads.

External observers call getAllCircuitStates() after resetTimeoutMs has elapsed. getState() returns 'half_open' (computed, no mutation) while the internal field remains 'open' until canRequest() is called, producing inconsistent reads.



