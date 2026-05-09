---
id: pattern_347c9f48d199071f
kind: pattern
source_path: swallowed cleanup errors
title: "Swallowed Cleanup Errors"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.833Z
---

# Swallowed Cleanup Errors

**Path:** `swallowed cleanup errors`  
**Kind:** `pattern`

> All close() calls in cleanup paths are wrapped in try/catch {}. Prevents a single broken transport from aborting the entire shutdown sequence or crashing the process.

All close() calls in cleanup paths are wrapped in try/catch {}. Prevents a single broken transport from aborting the entire shutdown sequence or crashing the process.



