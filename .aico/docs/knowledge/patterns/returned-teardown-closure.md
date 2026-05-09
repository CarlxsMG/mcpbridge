---
id: pattern_f44792dbab2d5b04
kind: pattern
source_path: returned teardown closure
title: "Returned Teardown Closure"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.910Z
---

# Returned Teardown Closure

**Path:** `returned teardown closure`  
**Kind:** `pattern`

> setupTransports returns a () => void rather than managing shutdown internally, allowing the caller (main entry point) to sequence teardown with other resources during graceful shutdown.

setupTransports returns a () => void rather than managing shutdown internally, allowing the caller (main entry point) to sequence teardown with other resources during graceful shutdown.



