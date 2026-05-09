---
id: failure_mode_b755d602849c9402
kind: failure_mode
source_path: config not restored on test throw
title: "Config not restored on test throw"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.724Z
---

# Config not restored on test throw

**Path:** `config not restored on test throw`  
**Kind:** `failure_mode`

> If middleware or an assertion throws before restoreConfig() is reached, subsequent tests inherit mutated config values, potentially causing cascading false failures.

If middleware or an assertion throws before restoreConfig() is reached, subsequent tests inherit mutated config values, potentially causing cascading false failures.



