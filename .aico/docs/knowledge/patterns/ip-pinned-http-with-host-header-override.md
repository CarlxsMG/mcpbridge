---
id: pattern_3190499be7585e5a
kind: pattern
source_path: ip-pinned http with host header override
title: "IP-Pinned HTTP with Host Header Override"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.821Z
---

# IP-Pinned HTTP with Host Header Override

**Path:** `ip-pinned http with host header override`  
**Kind:** `pattern`

> Replaces hostname with resolved_ip and injects original hostname as Host header. Decouples health request routing from DNS, closing DNS rebinding attack surface without breaking server-side virtual-host routing.

Replaces hostname with resolved_ip and injects original hostname as Host header. Decouples health request routing from DNS, closing DNS rebinding attack surface without breaking server-side virtual-host routing.



