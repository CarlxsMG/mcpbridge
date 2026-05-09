---
id: failure_mode_5e5015386880d0dc
kind: failure_mode
source_path: invalid logformat silently accepted
title: "Invalid logFormat silently accepted"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.669Z
---

# Invalid logFormat silently accepted

**Path:** `invalid logformat silently accepted`  
**Kind:** `failure_mode`

> LOG_FORMAT set to an unsupported value (e.g., "xml") is cast to the union type without validation. Downstream logger behavior is undefined and may panic or emit malformed output.

LOG_FORMAT set to an unsupported value (e.g., "xml") is cast to the union type without validation. Downstream logger behavior is undefined and may panic or emit malformed output.



