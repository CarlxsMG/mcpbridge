---
id: failure_mode_ffd5630e4a567642
kind: failure_mode
source_path: config maxconsecutivefailures ≤ failure_threshold
title: "Config maxConsecutiveFailures ≤ FAILURE_THRESHOLD"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.773Z
---

# Config maxConsecutiveFailures ≤ FAILURE_THRESHOLD

**Path:** `config maxconsecutivefailures ≤ failure_threshold`  
**Kind:** `failure_mode`

> If maxConsecutiveFailures is configured at or below 3, the unreachable promotion and auto-eviction fire simultaneously, skipping the 'unreachable but retained' grace window entirely.

If maxConsecutiveFailures is configured at or below 3, the unreachable promotion and auto-eviction fire simultaneously, skipping the 'unreachable but retained' grace window entirely.



