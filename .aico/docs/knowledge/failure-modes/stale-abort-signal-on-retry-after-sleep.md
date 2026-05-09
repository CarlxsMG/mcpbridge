---
id: failure_mode_71e59a5c400ff489
kind: failure_mode
source_path: stale abort signal on retry after sleep
title: "Stale Abort Signal on Retry After Sleep"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.683Z
---

# Stale Abort Signal on Retry After Sleep

**Path:** `stale abort signal on retry after sleep`  
**Kind:** `failure_mode`

> If the combined AbortSignal times out during a Retry-After or backoff sleep, the next fetch attempt immediately fails with an abort error rather than reaching the server.

If the combined AbortSignal times out during a Retry-After or backoff sleep, the next fetch attempt immediately fails with an abort error rather than reaching the server.



