---
id: failure_mode_afb736d3d5bc8b80
kind: failure_mode
source_path: stale tool index after re-registration
title: "Stale Tool Index After Re-registration"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.720Z
---

# Stale Tool Index After Re-registration

**Path:** `stale tool index after re-registration`  
**Kind:** `failure_mode`

> If the registry does not purge old tool keys before inserting new ones during re-registration, svc__old-tool resolves after the update, causing phantom tool dispatch in production.

If the registry does not purge old tool keys before inserting new ones during re-registration, svc__old-tool resolves after the update, causing phantom tool dispatch in production.



