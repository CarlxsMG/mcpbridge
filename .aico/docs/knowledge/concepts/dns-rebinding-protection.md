---
id: concept_6a8448cd57bff2ff
kind: concept
source_path: dns rebinding protection
title: "DNS Rebinding Protection"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.457Z
---

# DNS Rebinding Protection

**Path:** `dns rebinding protection`  
**Kind:** `concept`

> Replaces the request URL hostname with a pre-resolved IP address stored on the client record, while sending the original hostname in the Host header. Prevents DNS-based SSRF during long-lived connections.

Replaces the request URL hostname with a pre-resolved IP address stored on the client record, while sending the original hostname in the Host header. Prevents DNS-based SSRF during long-lived connections.
## Aliases

- `resolved_ip`
- `pinned IP`




