---
id: pattern_29239b09b47c717d
kind: pattern
source_path: defensive url normalization
title: "Defensive URL Normalization"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.820Z
---

# Defensive URL Normalization

**Path:** `defensive url normalization`  
**Kind:** `pattern`

> Relative URLs (no http prefix) are resolved to absolute using req.ip before SSRF validation, allowing backends to register with path-only URLs while keeping validation consistent.

Relative URLs (no http prefix) are resolved to absolute using req.ip before SSRF validation, allowing backends to register with path-only URLs while keeping validation consistent.



