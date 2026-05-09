---
id: failure_mode_55361a319e0a5d64
kind: failure_mode
source_path: missing arguments default bypass
title: "Missing arguments default bypass"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.667Z
---

# Missing arguments default bypass

**Path:** `missing arguments default bypass`  
**Kind:** `failure_mode`

> If proxyToolCall does not handle an empty-object args gracefully, tools that require arguments will receive {} instead of a validation error when the client omits the arguments field.

If proxyToolCall does not handle an empty-object args gracefully, tools that require arguments will receive {} instead of a validation error when the client omits the arguments field.



