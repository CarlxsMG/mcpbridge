---
id: pattern_79d97950325fbeec
kind: pattern
source_path: eager schema caching
title: "Eager Schema Caching"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.867Z
---

# Eager Schema Caching

**Path:** `eager schema caching`  
**Kind:** `pattern`

> openapi.yaml is parsed and $refs resolved once at module load, not per-request. Eliminates repeated FS I/O and recursive traversal costs for a read-only schema endpoint.

openapi.yaml is parsed and $refs resolved once at module load, not per-request. Eliminates repeated FS I/O and recursive traversal costs for a read-only schema endpoint.



