---
id: failure_mode_c781b024ea9bdc4d
kind: failure_mode
source_path: singleton state leakage between tests
title: "Singleton State Leakage Between Tests"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.737Z
---

# Singleton State Leakage Between Tests

**Path:** `singleton state leakage between tests`  
**Kind:** `failure_mode`

> If beforeEach cleanup is incomplete — e.g. getAllClients() returns stale data during iteration — subsequent tests inherit clients from prior tests, producing false positives.

If beforeEach cleanup is incomplete — e.g. getAllClients() returns stale data during iteration — subsequent tests inherit clients from prior tests, producing false positives.



