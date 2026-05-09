---
id: failure_mode_45425faed77d3cee
kind: failure_mode
source_path: memory leak from unremoved servers
title: "Memory leak from unremoved servers"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.660Z
---

# Memory leak from unremoved servers

**Path:** `memory leak from unremoved servers`  
**Kind:** `failure_mode`

> If a server's onclose hook never fires (e.g., due to an unclean shutdown), its reference remains in activeServers indefinitely, preventing GC and accumulating over restarts.

If a server's onclose hook never fires (e.g., due to an unclean shutdown), its reference remains in activeServers indefinitely, preventing GC and accumulating over restarts.



