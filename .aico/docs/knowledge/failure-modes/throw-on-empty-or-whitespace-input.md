---
id: failure_mode_8b28c6f52b496a10
kind: failure_mode
source_path: throw on empty or whitespace input
title: "Throw on empty or whitespace input"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.700Z
---

# Throw on empty or whitespace input

**Path:** `throw on empty or whitespace input`  
**Kind:** `failure_mode`

> Implementation accesses string methods without guarding against empty/whitespace strings, causing an exception; the edge-case tests use not.toThrow() assertions.

Implementation accesses string methods without guarding against empty/whitespace strings, causing an exception; the edge-case tests use not.toThrow() assertions.



