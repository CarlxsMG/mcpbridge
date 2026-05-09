---
id: pattern_d143b4f87faa089d
kind: pattern
source_path: force-exit fallback
title: "Force-Exit Fallback"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.894Z
---

# Force-Exit Fallback

**Path:** `force-exit fallback`  
**Kind:** `pattern`

> A setTimeout(process.exit(1), 10_000) guards against hung connections blocking the graceful shutdown indefinitely, ensuring the process supervisor can restart the service in a bounded time.

A setTimeout(process.exit(1), 10_000) guards against hung connections blocking the graceful shutdown indefinitely, ensuring the process supervisor can restart the service in a bounded time.



