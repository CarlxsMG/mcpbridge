---
id: pattern_73c4c98126d10e33
kind: pattern
source_path: constant-time secret comparison
title: "Constant-Time Secret Comparison"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.862Z
---

# Constant-Time Secret Comparison

**Path:** `constant-time secret comparison`  
**Kind:** `pattern`

> Using crypto.timingSafeEqual prevents timing oracle attacks where an attacker could deduce key characters by measuring response time differences. Critical for any secret comparison in auth paths.

Using crypto.timingSafeEqual prevents timing oracle attacks where an attacker could deduce key characters by measuring response time differences. Critical for any secret comparison in auth paths.



