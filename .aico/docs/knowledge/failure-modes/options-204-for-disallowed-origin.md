---
id: failure_mode_0052f75c6950e0bc
kind: failure_mode
source_path: options 204 for disallowed origin
title: "OPTIONS 204 for Disallowed Origin"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.618Z
---

# OPTIONS 204 for Disallowed Origin

**Path:** `options 204 for disallowed origin`  
**Kind:** `failure_mode`

> An origin not in the allowlist sends an OPTIONS preflight; server still responds 204 (no body), but without CORS headers — browser blocks the follow-up request. May confuse debugging.

An origin not in the allowlist sends an OPTIONS preflight; server still responds 204 (no body), but without CORS headers — browser blocks the follow-up request. May confuse debugging.



