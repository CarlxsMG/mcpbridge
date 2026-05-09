---
id: pattern_5f24e4babed99e2a
kind: pattern
source_path: set-based exclusion filter
title: "Set-Based Exclusion Filter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.848Z
---

# Set-Based Exclusion Filter

**Path:** `set-based exclusion filter`  
**Kind:** `pattern`

> excludeOperations is converted to a Set at iteration start for O(1) per-operation lookup, avoiding O(n²) cost when excluding many operationIds over large specs.

excludeOperations is converted to a Set at iteration start for O(1) per-operation lookup, avoiding O(n²) cost when excluding many operationIds over large specs.



