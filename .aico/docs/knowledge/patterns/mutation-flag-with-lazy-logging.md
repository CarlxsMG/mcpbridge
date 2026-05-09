---
id: pattern_1fb562dee196244c
kind: pattern
source_path: mutation flag with lazy logging
title: "Mutation Flag with Lazy Logging"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.819Z
---

# Mutation Flag with Lazy Logging

**Path:** `mutation flag with lazy logging`  
**Kind:** `pattern`

> A single boolean `wasSanitized` accumulates across all pipeline stages; the log call is deferred to the end. This avoids redundant log entries while still capturing that at least one mutation occurred.

A single boolean `wasSanitized` accumulates across all pipeline stages; the log call is deferred to the end. This avoids redundant log entries while still capturing that at least one mutation occurred.



