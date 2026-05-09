---
id: failure_mode_f8dcace083f0ca1e
kind: failure_mode
source_path: wildcard port over-matches
title: "Wildcard Port Over-Matches"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.771Z
---

# Wildcard Port Over-Matches

**Path:** `wildcard port over-matches`  
**Kind:** `failure_mode`

> Pattern `http://localhost:*` also matches origins like `http://localhost:evil.example.com` if the prefix check is not sufficiently precise.

Pattern `http://localhost:*` also matches origins like `http://localhost:evil.example.com` if the prefix check is not sufficiently precise.



