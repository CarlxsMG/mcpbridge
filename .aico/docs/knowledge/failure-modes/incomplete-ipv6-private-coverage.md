---
id: failure_mode_4e9634dde3d9346b
kind: failure_mode
source_path: incomplete ipv6 private coverage
title: "Incomplete IPv6 Private Coverage"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.666Z
---

# Incomplete IPv6 Private Coverage

**Path:** `incomplete ipv6 private coverage`  
**Kind:** `failure_mode`

> isBlockedIpv6 uses string-prefix heuristics, not bitmask matching. Addresses in the fe80::/10 block with prefixes outside fe8-feb (none exist today, but the logic is fragile) or non-canonical representations would evade the check.

isBlockedIpv6 uses string-prefix heuristics, not bitmask matching. Addresses in the fe80::/10 block with prefixes outside fe8-feb (none exist today, but the logic is fragile) or non-canonical representations would evade the check.



