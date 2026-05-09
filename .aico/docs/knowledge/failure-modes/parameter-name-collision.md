---
id: failure_mode_62ebd9c0a6a4964c
kind: failure_mode
source_path: parameter name collision
title: "Parameter Name Collision"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.672Z
---

# Parameter Name Collision

**Path:** `parameter name collision`  
**Kind:** `failure_mode`

> A path-item parameter and an operation-level parameter share the same name. Both are pushed to the params array; the operation-level one overwrites the path-level one in the properties map, which may be unintentional.

A path-item parameter and an operation-level parameter share the same name. Both are pushed to the params array; the operation-level one overwrites the path-level one in the properties map, which may be unintentional.



