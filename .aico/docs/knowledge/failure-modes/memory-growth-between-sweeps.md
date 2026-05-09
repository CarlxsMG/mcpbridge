---
id: failure_mode_29139393936686c9
kind: failure_mode
source_path: memory growth between sweeps
title: "Memory Growth Between Sweeps"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.645Z
---

# Memory Growth Between Sweeps

**Path:** `memory growth between sweeps`  
**Kind:** `failure_mode`

> Under a DDoS or high-traffic burst, many distinct IP/session keys are created and filled rapidly; the Map can grow significantly in the up-to-5-minute window before the cleanup sweep runs.

Under a DDoS or high-traffic burst, many distinct IP/session keys are created and filled rapidly; the Map can grow significantly in the up-to-5-minute window before the cleanup sweep runs.



