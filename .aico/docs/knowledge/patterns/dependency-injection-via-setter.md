---
id: pattern_0e1e0f99d3fbf4b6
kind: pattern
source_path: dependency injection via setter
title: "Dependency Injection via Setter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.811Z
---

# Dependency Injection via Setter

**Path:** `dependency injection via setter`  
**Kind:** `pattern`

> setSessionCountGetter avoids circular imports between transport layers and the metrics module. The default no-op fallback ensures the module is always safe to import without initialization order constraints.

setSessionCountGetter avoids circular imports between transport layers and the metrics module. The default no-op fallback ensures the module is always safe to import without initialization order constraints.



