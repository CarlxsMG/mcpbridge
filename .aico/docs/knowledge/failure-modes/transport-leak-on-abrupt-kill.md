---
id: failure_mode_b012413801df1ac5
kind: failure_mode
source_path: transport leak on abrupt kill
title: "Transport Leak on Abrupt Kill"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.721Z
---

# Transport Leak on Abrupt Kill

**Path:** `transport leak on abrupt kill`  
**Kind:** `failure_mode`

> SIGKILL received (not catchable); gracefulShutdown never runs, leaving MCP transport sessions and health-check timers unreleased until OS reclaims them.

SIGKILL received (not catchable); gracefulShutdown never runs, leaving MCP transport sessions and health-check timers unreleased until OS reclaims them.



