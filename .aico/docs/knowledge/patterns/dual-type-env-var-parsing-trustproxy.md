---
id: pattern_dd4dbf5c6a806bcb
kind: pattern
source_path: dual-type env var parsing (trustproxy)
title: "Dual-Type Env Var Parsing (trustProxy)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.901Z
---

# Dual-Type Env Var Parsing (trustProxy)

**Path:** `dual-type env var parsing (trustproxy)`  
**Kind:** `pattern`

> trustProxy accepts boolean "true" or a numeric string, matching the Express/Fastify trust proxy API surface. A ternary first checks the boolean case, then falls back to numeric parsing, handling both modes without a schema library.

trustProxy accepts boolean "true" or a numeric string, matching the Express/Fastify trust proxy API surface. A ternary first checks the boolean case, then falls back to numeric parsing, handling both modes without a schema library.



