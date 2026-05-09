---
id: concept_8a64ec493ed4c582
kind: concept
source_path: rolling latency window
title: "Rolling Latency Window"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.486Z
---

# Rolling Latency Window

**Path:** `rolling latency window`  
**Kind:** `concept`

> A fixed-size array (MAX_LATENCY_WINDOW = 100) of recent tool call durations. Oldest samples are evicted via Array.shift() when capacity is exceeded. Used to compute a lightweight moving average without unbounded memory growth.

A fixed-size array (MAX_LATENCY_WINDOW = 100) of recent tool call durations. Oldest samples are evicted via Array.shift() when capacity is exceeded. Used to compute a lightweight moving average without unbounded memory growth.
## Aliases

- `latency buffer`
- `sliding window`




