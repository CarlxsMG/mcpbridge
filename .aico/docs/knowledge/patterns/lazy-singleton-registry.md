---
id: pattern_0c0f10188fd055e5
kind: pattern
source_path: lazy singleton registry
title: "Lazy Singleton Registry"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.810Z
---

# Lazy Singleton Registry

**Path:** `lazy singleton registry`  
**Kind:** `pattern`

> Module-scoped Map with get-or-create logic in `getCircuitBreaker` ensures exactly one breaker per client name without requiring explicit initialization, while remaining fully testable via `removeCircuitBreaker`.

Module-scoped Map with get-or-create logic in `getCircuitBreaker` ensures exactly one breaker per client name without requiring explicit initialization, while remaining fully testable via `removeCircuitBreaker`.



