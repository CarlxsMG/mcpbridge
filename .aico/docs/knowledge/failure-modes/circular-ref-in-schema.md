---
id: failure_mode_f202913c64df5169
kind: failure_mode
source_path: circular $ref in schema
title: "Circular $ref in Schema"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.760Z
---

# Circular $ref in Schema

**Path:** `circular $ref in schema`  
**Kind:** `failure_mode`

> If openapi.yaml contains a circular schema reference, resolveRefs may leave a raw $ref string in the output for the cycle node rather than fully resolving it.

If openapi.yaml contains a circular schema reference, resolveRefs may leave a raw $ref string in the output for the cycle node rather than fully resolving it.



