---
id: failure_mode_95f5620d486f7edc
kind: failure_mode
source_path: header injection via unsanitised caller id
title: "Header Injection via Unsanitised Caller ID"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.705Z
---

# Header Injection via Unsanitised Caller ID

**Path:** `header injection via unsanitised caller id`  
**Kind:** `failure_mode`

> A client sends an arbitrary or oversized X-Request-ID value; the middleware forwards it verbatim into res.locals and response headers, potentially polluting logs or triggering header-size limits.

A client sends an arbitrary or oversized X-Request-ID value; the middleware forwards it verbatim into res.locals and response headers, potentially polluting logs or triggering header-size limits.



