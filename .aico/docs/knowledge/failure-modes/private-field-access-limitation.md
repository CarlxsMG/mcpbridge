---
id: failure_mode_88dc5d582ea2de69
kind: failure_mode
source_path: private field access limitation
title: "Private Field Access Limitation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.698Z
---

# Private Field Access Limitation

**Path:** `private field access limitation`  
**Kind:** `failure_mode`

> lastFailureTime and failureCount are private, preventing direct state injection. Tests must drive state through the public API, which can be verbose and fragile for edge-case setup.

lastFailureTime and failureCount are private, preventing direct state injection. Tests must drive state through the public API, which can be verbose and fragile for edge-case setup.



