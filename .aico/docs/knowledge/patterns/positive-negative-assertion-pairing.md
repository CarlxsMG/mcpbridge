---
id: pattern_6808ad97f85bcd63
kind: pattern
source_path: positive + negative assertion pairing
title: "Positive + Negative Assertion Pairing"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.851Z
---

# Positive + Negative Assertion Pairing

**Path:** `positive + negative assertion pairing`  
**Kind:** `pattern`

> Injection tests assert both what is absent (the stripped phrase) and, for partial injection, what is still present (the benign text). Prevents false positives where an over-aggressive sanitizer deletes everything.

Injection tests assert both what is absent (the stripped phrase) and, for partial injection, what is still present (the benign text). Prevents false positives where an over-aggressive sanitizer deletes everything.



