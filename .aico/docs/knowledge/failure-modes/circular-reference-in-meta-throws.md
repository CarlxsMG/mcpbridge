---
id: failure_mode_7622584e426ecc2f
kind: failure_mode
source_path: circular reference in meta throws
title: "Circular Reference in meta Throws"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.685Z
---

# Circular Reference in meta Throws

**Path:** `circular reference in meta throws`  
**Kind:** `failure_mode`

> If any value in the meta object contains a circular reference, JSON.stringify() will throw a TypeError, crashing the calling code with no fallback.

If any value in the meta object contains a circular reference, JSON.stringify() will throw a TypeError, crashing the calling code with no fallback.



