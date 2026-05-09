---
id: pattern_208f25f4a0481163
kind: pattern
source_path: exec-form cmd
title: "Exec-Form CMD"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.819Z
---

# Exec-Form CMD

**Path:** `exec-form cmd`  
**Kind:** `pattern`

> `CMD ["bun", "src/index.ts"]` uses exec form (no shell wrapper), so PID 1 is the Bun process itself. This ensures OS signals (SIGTERM, SIGINT) are delivered directly to the app for graceful shutdown.

`CMD ["bun", "src/index.ts"]` uses exec form (no shell wrapper), so PID 1 is the Bun process itself. This ensures OS signals (SIGTERM, SIGINT) are delivered directly to the app for graceful shutdown.



