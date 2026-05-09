---
id: failure_mode_00de4d667d78a582
kind: failure_mode
source_path: custom config unreachable via public api
title: "Custom Config Unreachable via Public API"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.618Z
---

# Custom Config Unreachable via Public API

**Path:** `custom config unreachable via public api`  
**Kind:** `failure_mode`

> Callers using getCircuitBreaker() always receive a breaker with DEFAULT_CONFIG. Per-client threshold or timeout tuning silently falls back to defaults unless the caller directly constructs CircuitBreaker (not exported).

Callers using getCircuitBreaker() always receive a breaker with DEFAULT_CONFIG. Per-client threshold or timeout tuning silently falls back to defaults unless the caller directly constructs CircuitBreaker (not exported).



