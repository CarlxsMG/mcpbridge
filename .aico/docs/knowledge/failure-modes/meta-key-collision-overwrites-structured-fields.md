---
id: failure_mode_a0a71d978dc3b396
kind: failure_mode
source_path: meta key collision overwrites structured fields
title: "Meta Key Collision Overwrites Structured Fields"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.715Z
---

# Meta Key Collision Overwrites Structured Fields

**Path:** `meta key collision overwrites structured fields`  
**Kind:** `failure_mode`

> Caller passes a meta object with keys 'timestamp', 'level', or 'message' in JSON mode; the spread silently overwrites the structured fields, corrupting the log entry.

Caller passes a meta object with keys 'timestamp', 'level', or 'message' in JSON mode; the spread silently overwrites the structured fields, corrupting the log entry.



