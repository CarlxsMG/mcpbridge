---
id: failure_mode_99b458d65e6b4966
kind: failure_mode
source_path: off-by-one truncation boundary
title: "Off-by-one truncation boundary"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.707Z
---

# Off-by-one truncation boundary

**Path:** `off-by-one truncation boundary`  
**Kind:** `failure_mode`

> Implementation uses >= 500 instead of > 500 for the truncation condition; the exact-500-char boundary test would catch this.

Implementation uses >= 500 instead of > 500 for the truncation condition; the exact-500-char boundary test would catch this.



