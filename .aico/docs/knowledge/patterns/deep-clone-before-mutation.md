---
id: pattern_e1923fcc3da46323
kind: pattern
source_path: deep clone before mutation
title: "Deep Clone Before Mutation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.902Z
---

# Deep Clone Before Mutation

**Path:** `deep clone before mutation`  
**Kind:** `pattern`

> resolveRefs is called on JSON.parse(JSON.stringify(schema)) to protect _schemaComponents from in-place mutation, allowing the cached components to be reused across multiple calls.

resolveRefs is called on JSON.parse(JSON.stringify(schema)) to protect _schemaComponents from in-place mutation, allowing the cached components to be reused across multiple calls.



