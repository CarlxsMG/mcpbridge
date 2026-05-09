---
id: pattern_44e520d9de4b2172
kind: pattern
source_path: immediate-then-interval scheduler
title: "Immediate-Then-Interval Scheduler"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.835Z
---

# Immediate-Then-Interval Scheduler

**Path:** `immediate-then-interval scheduler`  
**Kind:** `pattern`

> Running check() once before setInterval ensures zero cold-start lag — the registry reflects real client states immediately on startup rather than waiting one full interval.

Running check() once before setInterval ensures zero cold-start lag — the registry reflects real client states immediately on startup rather than waiting one full interval.



