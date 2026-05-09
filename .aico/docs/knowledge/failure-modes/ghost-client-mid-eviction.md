---
id: failure_mode_1f0f2f55b134820c
kind: failure_mode
source_path: ghost client mid-eviction
title: "Ghost client mid-eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.636Z
---

# Ghost client mid-eviction

**Path:** `ghost client mid-eviction`  
**Kind:** `failure_mode`

> Client is unregistered externally between getAllClients() snapshot and handleFailure execution; guarded by an early-return null check but the snapshot still processes the stale entry.

Client is unregistered externally between getAllClients() snapshot and handleFailure execution; guarded by an early-return null check but the snapshot still processes the stale entry.



