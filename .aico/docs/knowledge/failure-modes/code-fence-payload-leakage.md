---
id: failure_mode_93c14a48c818067a
kind: failure_mode
source_path: code-fence payload leakage
title: "Code-fence payload leakage"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.704Z
---

# Code-fence payload leakage

**Path:** `code-fence payload leakage`  
**Kind:** `failure_mode`

> Sanitizer removes ``` delimiters but leaves the inner payload text; the markdown code-block test checks both fence markers and payload content are absent.

Sanitizer removes ``` delimiters but leaves the inner payload text; the markdown code-block test checks both fence markers and payload content are absent.



