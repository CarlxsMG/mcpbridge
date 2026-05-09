---
id: failure_mode_d44ce166b12d681f
kind: failure_mode
source_path: type drift without build check in ci
title: "Type Drift Without Build Check in CI"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.745Z
---

# Type Drift Without Build Check in CI

**Path:** `type drift without build check in ci`  
**Kind:** `failure_mode`

> If typecheck script is not run in CI, TypeScript errors silently ignored by Bun's transpiler can accumulate and surface only at runtime as undefined-behavior bugs.

If typecheck script is not run in CI, TypeScript errors silently ignored by Bun's transpiler can accumulate and surface only at runtime as undefined-behavior bugs.



