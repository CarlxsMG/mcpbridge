---
id: failure_mode_0c6a19d97bb41ebd
kind: failure_mode
source_path: batch timeout cascade
title: "Batch timeout cascade"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.623Z
---

# Batch timeout cascade

**Path:** `batch timeout cascade`  
**Kind:** `failure_mode`

> All 20 concurrent checks in a batch hang until AbortSignal fires; total batch duration equals healthCheckTimeoutMs, potentially overrunning the healthCheckIntervalMs and causing interval stacking.

All 20 concurrent checks in a batch hang until AbortSignal fires; total batch duration equals healthCheckTimeoutMs, potentially overrunning the healthCheckIntervalMs and causing interval stacking.



