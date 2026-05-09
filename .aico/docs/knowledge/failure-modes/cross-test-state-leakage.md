---
id: failure_mode_6612d98734a7d85c
kind: failure_mode
source_path: cross-test state leakage
title: "Cross-Test State Leakage"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.674Z
---

# Cross-Test State Leakage

**Path:** `cross-test state leakage`  
**Kind:** `failure_mode`

> If removeCircuitBreaker is not called before a test, a previous test's open/half_open state persists in the module map, causing subsequent assertions to fail unexpectedly.

If removeCircuitBreaker is not called before a test, a previous test's open/half_open state persists in the module map, causing subsequent assertions to fail unexpectedly.



