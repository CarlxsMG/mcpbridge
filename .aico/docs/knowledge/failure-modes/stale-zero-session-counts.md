---
id: failure_mode_6bab63ad0956158c
kind: failure_mode
source_path: stale zero session counts
title: "Stale Zero Session Counts"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.681Z
---

# Stale Zero Session Counts

**Path:** `stale zero session counts`  
**Kind:** `failure_mode`

> setSessionCountGetter is never called during bootstrap; /metrics always reports 0 active sessions for both transport types without any error signal.

setSessionCountGetter is never called during bootstrap; /metrics always reports 0 active sessions for both transport types without any error signal.



