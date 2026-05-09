---
id: pattern_d2e4966e800d727d
kind: pattern
source_path: rolling window aggregation
title: "Rolling Window Aggregation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.895Z
---

# Rolling Window Aggregation

**Path:** `rolling window aggregation`  
**Kind:** `pattern`

> Capping the latency array at 100 entries with shift() provides bounded memory usage for a lightweight moving average, avoiding the complexity of a time-series store while still surfacing recent performance trends.

Capping the latency array at 100 entries with shift() provides bounded memory usage for a lightweight moving average, avoiding the complexity of a time-series store while still surfacing recent performance trends.



