---
id: pattern_dea6e5709fb2b4b1
kind: pattern
source_path: date.now monkey-patch in try/finally
title: "Date.now Monkey-Patch in try/finally"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.902Z
---

# Date.now Monkey-Patch in try/finally

**Path:** `date.now monkey-patch in try/finally`  
**Kind:** `pattern`

> Replaces Date.now globally for the duration of a single assertion block and restores it in finally, enabling time-sensitive behaviour tests without real waits or timer mocks.

Replaces Date.now globally for the duration of a single assertion block and restores it in finally, enabling time-sensitive behaviour tests without real waits or timer mocks.



