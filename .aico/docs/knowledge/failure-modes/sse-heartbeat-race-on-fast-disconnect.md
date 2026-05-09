---
id: failure_mode_43ada9828eaf1b33
kind: failure_mode
source_path: sse heartbeat race on fast disconnect
title: "SSE Heartbeat Race on Fast Disconnect"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.656Z
---

# SSE Heartbeat Race on Fast Disconnect

**Path:** `sse heartbeat race on fast disconnect`  
**Kind:** `failure_mode`

> If req.close fires before server.connect resolves, the close handler calls server?.close() via optional chain safely, but the heartbeat interval may fire once before being cleared.

If req.close fires before server.connect resolves, the close handler calls server?.close() via optional chain safely, but the heartbeat interval may fire once before being cleared.



