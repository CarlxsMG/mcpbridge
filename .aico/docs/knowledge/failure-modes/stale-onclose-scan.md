---
id: failure_mode_b0c955be9cfc42aa
kind: failure_mode
source_path: stale onclose scan
title: "Stale onclose Scan"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.721Z
---

# Stale onclose Scan

**Path:** `stale onclose scan`  
**Kind:** `failure_mode`

> transport.onclose searches streamableSessions by value; if the Map is large, eviction on transport close is O(n). Under high session churn this degrades to O(n²) cleanup cost.

transport.onclose searches streamableSessions by value; if the Map is large, eviction on transport close is O(n). Under high session churn this degrades to O(n²) cleanup cost.



