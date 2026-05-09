---
id: failure_mode_e9f0023e9a46002a
kind: failure_mode
source_path: runtime crash on old node.js
title: "Runtime Crash on Old Node.js"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.756Z
---

# Runtime Crash on Old Node.js

**Path:** `runtime crash on old node.js`  
**Kind:** `failure_mode`

> crypto.randomUUID is undefined on Node.js < 14.17.0; calling it throws a TypeError, crashing the request pipeline unless the error is caught upstream.

crypto.randomUUID is undefined on Node.js < 14.17.0; calling it throws a TypeError, crashing the request pipeline unless the error is caught upstream.



