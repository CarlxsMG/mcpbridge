---
id: failure_mode_bf4f2a03bbcadead
kind: failure_mode
source_path: date.now not restored on assertion error
title: "Date.now Not Restored on Assertion Error"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.732Z
---

# Date.now Not Restored on Assertion Error

**Path:** `date.now not restored on assertion error`  
**Kind:** `failure_mode`

> If the try block throws before the finally runs (e.g. assertion failure rethrows), Date.now remains overridden for all subsequent tests. The try/finally pattern prevents this, but removing it would break global time.

If the try block throws before the finally runs (e.g. assertion failure rethrows), Date.now remains overridden for all subsequent tests. The try/finally pattern prevents this, but removing it would break global time.



