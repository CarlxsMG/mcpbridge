---
id: failure_mode_e8eb0e77312b5fec
kind: failure_mode
source_path: zero-value numeric env var ignored
title: "Zero-value numeric env var ignored"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.756Z
---

# Zero-value numeric env var ignored

**Path:** `zero-value numeric env var ignored`  
**Kind:** `failure_mode`

> Setting any numeric env var to "0" (e.g., PORT=0) causes Number("0") || default to evaluate the default, silently overriding the intended value. Affects all numeric fields.

Setting any numeric env var to "0" (e.g., PORT=0) causes Number("0") || default to evaluate the default, silently overriding the intended value. Affects all numeric fields.



