---
id: pattern_1646ba2ac17f69cc
kind: pattern
source_path: inline teardown (restoreconfig after act)
title: "Inline Teardown (restoreConfig after act)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.817Z
---

# Inline Teardown (restoreConfig after act)

**Path:** `inline teardown (restoreconfig after act)`  
**Kind:** `pattern`

> Restoring config immediately after middleware invocation, rather than in afterEach, makes each test self-contained and explicit about cleanup order, though it only works safely with synchronous code.

Restoring config immediately after middleware invocation, rather than in afterEach, makes each test self-contained and explicit about cleanup order, though it only works safely with synchronous code.



