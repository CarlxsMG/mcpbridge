---
id: pattern_cef5518bb4daa50a
kind: pattern
source_path: request-scoped context via res.locals
title: "Request-Scoped Context via res.locals"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.894Z
---

# Request-Scoped Context via res.locals

**Path:** `request-scoped context via res.locals`  
**Kind:** `pattern`

> Storing the ID on res.locals rather than mutating req keeps the value accessible to all downstream Express handlers within the request lifecycle without polluting the request object.

Storing the ID on res.locals rather than mutating req keeps the value accessible to all downstream Express handlers within the request lifecycle without polluting the request object.



