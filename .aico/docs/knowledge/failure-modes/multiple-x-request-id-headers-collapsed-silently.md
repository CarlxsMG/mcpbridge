---
id: failure_mode_9802848e7fbc9c11
kind: failure_mode
source_path: multiple x-request-id headers collapsed silently
title: "Multiple X-Request-ID Headers Collapsed Silently"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.706Z
---

# Multiple X-Request-ID Headers Collapsed Silently

**Path:** `multiple x-request-id headers collapsed silently`  
**Kind:** `failure_mode`

> A client sends duplicate X-Request-ID headers; Express joins them with a comma and the cast to string succeeds, producing a malformed ID used for tracing without any warning.

A client sends duplicate X-Request-ID headers; Express joins them with a comma and the cast to string succeeds, producing a malformed ID used for tracing without any warning.



