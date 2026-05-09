---
id: failure_mode_126da2f142356337
kind: failure_mode
source_path: setinterval prevents clean exit
title: "setInterval Prevents Clean Exit"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.628Z
---

# setInterval Prevents Clean Exit

**Path:** `setinterval prevents clean exit`  
**Kind:** `failure_mode`

> The cleanup interval is never unref'd; in test suites or graceful-shutdown scenarios the open handle keeps the process alive until the interval fires or the process is force-killed.

The cleanup interval is never unref'd; in test suites or graceful-shutdown scenarios the open handle keeps the process alive until the interval fires or the process is force-killed.



