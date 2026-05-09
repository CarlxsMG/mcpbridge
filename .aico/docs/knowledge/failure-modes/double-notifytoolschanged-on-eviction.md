---
id: failure_mode_5f9092dec4dc425d
kind: failure_mode
source_path: double notifytoolschanged on eviction
title: "Double notifyToolsChanged on eviction"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.670Z
---

# Double notifyToolsChanged on eviction

**Path:** `double notifytoolschanged on eviction`  
**Kind:** `failure_mode`

> If a client is already unreachable when auto-eviction triggers, notifyToolsChanged fires once for the unreachable→unreachable noop skip and once post-unregister, causing a redundant but harmless notification.

If a client is already unreachable when auto-eviction triggers, notifyToolsChanged fires once for the unreachable→unreachable noop skip and once post-unregister, causing a redundant but harmless notification.



