---
id: failure_mode_42e0471d723c5e44
kind: failure_mode
source_path: dns resolution returns only ipv6
title: "DNS Resolution Returns Only IPv6"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.655Z
---

# DNS Resolution Returns Only IPv6

**Path:** `dns resolution returns only ipv6`  
**Kind:** `failure_mode`

> Bun.dns.lookup is called with { family: 4 }; a hostname with only AAAA records returns an empty array, causing the URL to be rejected with 'no records' even if the host is legitimate.

Bun.dns.lookup is called with { family: 4 }; a hostname with only AAAA records returns an empty array, causing the URL to be rejected with 'no records' even if the host is legitimate.



