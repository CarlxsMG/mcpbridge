---
id: failure_mode_f514d20aa6c404b5
kind: failure_mode
source_path: warn level emitted to stdout instead of stderr
title: "warn Level Emitted to stdout Instead of stderr"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.767Z
---

# warn Level Emitted to stdout Instead of stderr

**Path:** `warn level emitted to stdout instead of stderr`  
**Kind:** `failure_mode`

> Level is 'warn' — the console routing check only gates on 'error', so warn goes to console.log (stdout), breaking stream-based log separation assumptions.

Level is 'warn' — the console routing check only gates on 'error', so warn goes to console.log (stdout), breaking stream-based log separation assumptions.



