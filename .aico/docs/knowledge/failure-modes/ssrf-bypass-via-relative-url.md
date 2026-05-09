---
id: failure_mode_be15d95110a36a40
kind: failure_mode
source_path: ssrf bypass via relative url
title: "SSRF Bypass via Relative URL"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.729Z
---

# SSRF Bypass via Relative URL

**Path:** `ssrf bypass via relative url`  
**Kind:** `failure_mode`

> If validateBackendUrl is not invoked on the resolved absolute URL (only the raw relative), a crafted path could direct the server to internal hosts. Code resolves first, then validates — correct order.

If validateBackendUrl is not invoked on the resolved absolute URL (only the raw relative), a crafted path could direct the server to internal hosts. Code resolves first, then validates — correct order.



