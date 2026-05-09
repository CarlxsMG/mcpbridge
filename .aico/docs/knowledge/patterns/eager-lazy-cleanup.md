---
id: pattern_b31cf3c3d4c0cc20
kind: pattern
source_path: eager + lazy cleanup
title: "Eager + Lazy Cleanup"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.880Z
---

# Eager + Lazy Cleanup

**Path:** `eager + lazy cleanup`  
**Kind:** `pattern`

> Tokens are pruned eagerly on every checkLimit call for accuracy, and lazily by a periodic setInterval sweep for memory hygiene — combining correctness with bounded memory cost.

Tokens are pruned eagerly on every checkLimit call for accuracy, and lazily by a periodic setInterval sweep for memory hygiene — combining correctness with bounded memory cost.



