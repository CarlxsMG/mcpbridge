---
id: pattern_1cd38d081e49e243
kind: pattern
source_path: startup-time eager loading
title: "Startup-time Eager Loading"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.818Z
---

# Startup-time Eager Loading

**Path:** `startup-time eager loading`  
**Kind:** `pattern`

> Reading static assets (the YAML spec) synchronously during registration fails fast on misconfiguration and avoids repeated I/O on every request, appropriate for files that do not change at runtime.

Reading static assets (the YAML spec) synchronously during registration fails fast on misconfiguration and avoids repeated I/O on every request, appropriate for files that do not change at runtime.



