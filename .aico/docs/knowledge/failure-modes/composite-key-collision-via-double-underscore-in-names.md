---
id: failure_mode_6db114eb0444fd83
kind: failure_mode
source_path: composite key collision via double-underscore in names
title: "Composite Key Collision via Double-Underscore in Names"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.681Z
---

# Composite Key Collision via Double-Underscore in Names

**Path:** `composite key collision via double-underscore in names`  
**Kind:** `failure_mode`

> A client named 'a__b' with tool 'c' produces the same key as client 'a' with tool 'b__c'. The test suite does not assert this, relying on the name regex to implicitly prevent it.

A client named 'a__b' with tool 'c' produces the same key as client 'a' with tool 'b__c'. The test suite does not assert this, relying on the name regex to implicitly prevent it.



