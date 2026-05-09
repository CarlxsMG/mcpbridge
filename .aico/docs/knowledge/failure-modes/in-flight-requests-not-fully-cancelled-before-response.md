---
id: failure_mode_f53c93b8000a0c99
kind: failure_mode
source_path: in-flight requests not fully cancelled before response
title: "In-flight Requests Not Fully Cancelled Before Response"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.767Z
---

# In-flight Requests Not Fully Cancelled Before Response

**Path:** `in-flight requests not fully cancelled before response`  
**Kind:** `failure_mode`

> abortClientRequests is called synchronously but request cancellation may be asynchronous; the 200 response can be sent before all proxy connections are actually torn down.

abortClientRequests is called synchronously but request cancellation may be asynchronous; the 200 response can be sent before all proxy connections are actually torn down.



