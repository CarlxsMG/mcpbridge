---
id: pattern_6cb6d6d96ac924f7
kind: pattern
source_path: master bypass flag
title: "Master Bypass Flag"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.852Z
---

# Master Bypass Flag

**Path:** `master bypass flag`  
**Kind:** `pattern`

> A single config boolean (authDisabled) disables all auth uniformly. Simplifies local development without requiring code changes, but must be guarded by environment-specific config to avoid production exposure.

A single config boolean (authDisabled) disables all auth uniformly. Simplifies local development without requiring code changes, but must be guarded by environment-specific config to avoid production exposure.



