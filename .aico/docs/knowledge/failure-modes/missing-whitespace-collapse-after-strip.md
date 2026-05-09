---
id: failure_mode_0511b4b89aa3f5a8
kind: failure_mode
source_path: missing whitespace collapse after strip
title: "Missing whitespace collapse after strip"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.620Z
---

# Missing whitespace collapse after strip

**Path:** `missing whitespace collapse after strip`  
**Kind:** `failure_mode`

> Sanitizer removes injection phrase but does not collapse resulting double-spaces; the 'collapses multiple spaces' test asserts no /\s{2,}/ matches.

Sanitizer removes injection phrase but does not collapse resulting double-spaces; the 'collapses multiple spaces' test asserts no /\s{2,}/ matches.



