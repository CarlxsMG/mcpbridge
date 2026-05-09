---
id: failure_mode_609852210237fa69
kind: failure_mode
source_path: unknown ip bucket collision
title: "Unknown IP Bucket Collision"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.671Z
---

# Unknown IP Bucket Collision

**Path:** `unknown ip bucket collision`  
**Kind:** `failure_mode`

> Clients where both req.ip and req.socket.remoteAddress are unavailable all resolve to key 'register:unknown' or 'mcp:unknown', sharing a single bucket.

Clients where both req.ip and req.socket.remoteAddress are unavailable all resolve to key 'register:unknown' or 'mcp:unknown', sharing a single bucket.



