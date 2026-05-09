---
id: failure_mode_df9baa0da862377c
kind: failure_mode
source_path: greedy code block over-removal
title: "Greedy Code Block Over-removal"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.753Z
---

# Greedy Code Block Over-removal

**Path:** `greedy code block over-removal`  
**Kind:** `failure_mode`

> If a description contains an unmatched opening backtick fence, the lazy regex may not match and the content passes through unsanitized. Malformed markdown is not caught.

If a description contains an unmatched opening backtick fence, the lazy regex may not match and the content passes through unsanitized. Malformed markdown is not caught.



