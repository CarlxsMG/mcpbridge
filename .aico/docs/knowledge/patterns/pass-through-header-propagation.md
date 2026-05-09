---
id: pattern_d915406d194fe9f0
kind: pattern
source_path: pass-through header propagation
title: "Pass-Through Header Propagation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.900Z
---

# Pass-Through Header Propagation

**Path:** `pass-through header propagation`  
**Kind:** `pattern`

> Honour a caller-supplied header value first, falling back to local generation. Preserves distributed trace context when requests originate from an upstream service that already assigned an ID.

Honour a caller-supplied header value first, falling back to local generation. Preserves distributed trace context when requests originate from an upstream service that already assigned an ID.



