---
id: pattern_442647151ed1ce94
kind: pattern
source_path: keyed namespace isolation
title: "Keyed Namespace Isolation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.835Z
---

# Keyed Namespace Isolation

**Path:** `keyed namespace isolation`  
**Kind:** `pattern`

> Rate-limit keys are prefixed by scope ('register:', 'mcp:', 'global') to prevent accidental cross-route bucket collisions when different middlewares share the same module-level Map.

Rate-limit keys are prefixed by scope ('register:', 'mcp:', 'global') to prevent accidental cross-route bucket collisions when different middlewares share the same module-level Map.



