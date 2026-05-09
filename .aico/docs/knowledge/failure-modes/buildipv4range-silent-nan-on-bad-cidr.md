---
id: failure_mode_dd5d232d24dbb312
kind: failure_mode
source_path: buildipv4range silent nan on bad cidr
title: "buildIpv4Range Silent NaN on Bad CIDR"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.752Z
---

# buildIpv4Range Silent NaN on Bad CIDR

**Path:** `buildipv4range silent nan on bad cidr`  
**Kind:** `failure_mode`

> If an invalid CIDR string is passed to buildIpv4Range, ipv4ToUint32 returns null cast as number, producing NaN-derived bitmask values that corrupt range checks without throwing.

If an invalid CIDR string is passed to buildIpv4Range, ipv4ToUint32 returns null cast as number, producing NaN-derived bitmask values that corrupt range checks without throwing.



