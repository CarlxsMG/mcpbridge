---
id: pattern_5ca56329ad65bf70
kind: pattern
source_path: preflight short-circuit
title: "Preflight Short-Circuit"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.847Z
---

# Preflight Short-Circuit

**Path:** `preflight short-circuit`  
**Kind:** `pattern`

> Responding immediately to OPTIONS with 204 and returning prevents unnecessary downstream middleware and route handler execution for preflight requests, which require no business logic.

Responding immediately to OPTIONS with 204 and returning prevents unnecessary downstream middleware and route handler execution for preflight requests, which require no business logic.



