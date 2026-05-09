---
id: failure_mode_7d5953c77bba6138
kind: failure_mode
source_path: stale toolindex after crash
title: "Stale toolIndex After Crash"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.686Z
---

# Stale toolIndex After Crash

**Path:** `stale toolindex after crash`  
**Kind:** `failure_mode`

> If the process restarts without calling unregister(), the in-memory maps are empty. No persistence means clients must re-register after restart.

If the process restarts without calling unregister(), the in-memory maps are empty. No persistence means clients must re-register after restart.



