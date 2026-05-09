---
id: failure_mode_25a1dbd572685296
kind: failure_mode
source_path: inflated uptime on lazy import
title: "Inflated Uptime on Lazy Import"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.637Z
---

# Inflated Uptime on Lazy Import

**Path:** `inflated uptime on lazy import`  
**Kind:** `failure_mode`

> If the module is imported significantly before the HTTP server begins accepting connections, startedAt captures import time rather than listen time, overstating uptime_seconds.

If the module is imported significantly before the HTTP server begins accepting connections, startedAt captures import time rather than listen time, overstating uptime_seconds.



