---
id: pattern_890a3fb7d4db7a72
kind: pattern
source_path: strict boolean string check
title: "Strict Boolean String Check"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.870Z
---

# Strict Boolean String Check

**Path:** `strict boolean string check`  
**Kind:** `pattern`

> Boolean flags (authDisabled, allowPrivateIps) use === "true" rather than truthy coercion. This prevents accidental activation from values like "1", "yes", or "TRUE", enforcing explicit opt-in to sensitive behaviors.

Boolean flags (authDisabled, allowPrivateIps) use === "true" rather than truthy coercion. This prevents accidental activation from values like "1", "yes", or "TRUE", enforcing explicit opt-in to sensitive behaviors.



