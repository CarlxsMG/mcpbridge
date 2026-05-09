---
id: pattern_3c72e523da9f9d08
kind: pattern
source_path: opt-in security via empty-list fallback
title: "Opt-In Security via Empty-List Fallback"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.834Z
---

# Opt-In Security via Empty-List Fallback

**Path:** `opt-in security via empty-list fallback`  
**Kind:** `pattern`

> mcpAuth treats an empty key list as 'allow all' for backward compatibility. New deployments must explicitly populate keys to enforce auth, making the secure state opt-in rather than default.

mcpAuth treats an empty key list as 'allow all' for backward compatibility. New deployments must explicitly populate keys to enforce auth, making the secure state opt-in rather than default.



