---
id: failure_mode_e45bfe2f82b014ab
kind: failure_mode
source_path: force-exit with non-zero code
title: "Force-Exit with Non-Zero Code"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.755Z
---

# Force-Exit with Non-Zero Code

**Path:** `force-exit with non-zero code`  
**Kind:** `failure_mode`

> Active connections (e.g. long-lived SSE streams) fail to drain within 10 seconds after SIGTERM/SIGINT; process.exit(1) fires, potentially causing supervisor restart loops.

Active connections (e.g. long-lived SSE streams) fail to drain within 10 seconds after SIGTERM/SIGINT; process.exit(1) fires, potentially causing supervisor restart loops.



