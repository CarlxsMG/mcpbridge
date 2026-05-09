---
id: failure_mode_4943ca309cd929ab
kind: failure_mode
source_path: key rotation race window
title: "Key Rotation Race Window"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.662Z
---

# Key Rotation Race Window

**Path:** `key rotation race window`  
**Kind:** `failure_mode`

> If an old key is removed from the config before all clients have been updated to the new key, in-flight requests using the old key will receive 403 errors during the transition.

If an old key is removed from the config before all clients have been updated to the new key, in-flight requests using the old key will receive 403 errors during the transition.



