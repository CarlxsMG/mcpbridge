---
id: pattern_66d0ba668cd5a017
kind: pattern
source_path: pinned-ip dns rebinding protection
title: "Pinned-IP DNS Rebinding Protection"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.849Z
---

# Pinned-IP DNS Rebinding Protection

**Path:** `pinned-ip dns rebinding protection`  
**Kind:** `pattern`

> Replacing the request hostname with a pre-resolved IP at dispatch time (while preserving the Host header) eliminates the window for DNS-based SSRF attacks during request execution.

Replacing the request hostname with a pre-resolved IP at dispatch time (while preserving the Host header) eliminates the window for DNS-based SSRF attacks during request execution.



