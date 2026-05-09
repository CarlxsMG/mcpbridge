---
id: pattern_b857d21f80ff29bc
kind: pattern
source_path: composite key namespacing
title: "Composite Key Namespacing"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.884Z
---

# Composite Key Namespacing

**Path:** `composite key namespacing`  
**Kind:** `pattern`

> The clientName__toolName double-underscore key enables O(1) cross-client tool resolution with no namespace collision, provided the validation regex prevents __ from appearing in either segment.

The clientName__toolName double-underscore key enables O(1) cross-client tool resolution with no namespace collision, provided the validation regex prevents __ from appearing in either segment.



