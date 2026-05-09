---
id: failure_mode_26bb56f39f8f3b64
kind: failure_mode
source_path: half-open probe stampede
title: "Half-Open Probe Stampede"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.641Z
---

# Half-Open Probe Stampede

**Path:** `half-open probe stampede`  
**Kind:** `failure_mode`

> Multiple goroutines/async calls invoke canRequest() concurrently while state is half_open. All receive allowed:true simultaneously — no in-flight probe counter exists — so more than one probe fires, defeating single-probe intent.

Multiple goroutines/async calls invoke canRequest() concurrently while state is half_open. All receive allowed:true simultaneously — no in-flight probe counter exists — so more than one probe fires, defeating single-probe intent.



