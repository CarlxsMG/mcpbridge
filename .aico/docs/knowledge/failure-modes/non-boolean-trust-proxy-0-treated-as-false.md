---
id: failure_mode_2619b33087af2218
kind: failure_mode
source_path: non-boolean trust_proxy=0 treated as false
title: "Non-boolean TRUST_PROXY=0 treated as false"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.639Z
---

# Non-boolean TRUST_PROXY=0 treated as false

**Path:** `non-boolean trust_proxy=0 treated as false`  
**Kind:** `failure_mode`

> TRUST_PROXY="0" evaluates to Number("0") || false = false, disabling proxy trust even though the operator may have intended to trust zero hops explicitly (a no-op but surprising).

TRUST_PROXY="0" evaluates to Number("0") || false = false, disabling proxy trust even though the operator may have intended to trust zero hops explicitly (a no-op but surprising).



