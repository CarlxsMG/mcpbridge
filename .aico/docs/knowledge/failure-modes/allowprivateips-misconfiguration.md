---
id: failure_mode_41e894e7b40bcbfb
kind: failure_mode
source_path: allowprivateips misconfiguration
title: "allowPrivateIps Misconfiguration"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.653Z
---

# allowPrivateIps Misconfiguration

**Path:** `allowprivateips misconfiguration`  
**Kind:** `failure_mode`

> Passing allowPrivateIps=true disables all IP range blocking. If this flag leaks into a production code path (e.g., via misconfigured env variable), SSRF protection is fully disabled.

Passing allowPrivateIps=true disables all IP range blocking. If this flag leaks into a production code path (e.g., via misconfigured env variable), SSRF protection is fully disabled.



