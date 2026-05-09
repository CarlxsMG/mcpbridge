---
id: pattern_c8124eaa2e85bec9
kind: pattern
source_path: dual-layer size guard
title: "Dual-Layer Size Guard"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.889Z
---

# Dual-Layer Size Guard

**Path:** `dual-layer size guard`  
**Kind:** `pattern`

> Checks both the content-length response header and actual decoded text length against a 5 MB cap. Defends against servers that omit or misreport content-length.

Checks both the content-length response header and actual decoded text length against a 5 MB cap. Defends against servers that omit or misreport content-length.



