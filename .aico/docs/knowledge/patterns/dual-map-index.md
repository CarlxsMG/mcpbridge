---
id: pattern_07a0237766091882
kind: pattern
source_path: dual-map index
title: "Dual-Map Index"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.809Z
---

# Dual-Map Index

**Path:** `dual-map index`  
**Kind:** `pattern`

> Maintaining both `clients` (by name) and `toolIndex` (by composite key) enables O(1) tool resolution and O(1) client lookup without nested iteration, at the cost of coordinated writes.

Maintaining both `clients` (by name) and `toolIndex` (by composite key) enables O(1) tool resolution and O(1) client lookup without nested iteration, at the cost of coordinated writes.



