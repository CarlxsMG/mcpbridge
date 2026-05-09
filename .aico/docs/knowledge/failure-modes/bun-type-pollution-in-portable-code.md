---
id: failure_mode_000fe07d8f5a1991
kind: failure_mode
source_path: bun-type pollution in portable code
title: "Bun-type pollution in portable code"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.618Z
---

# Bun-type pollution in portable code

**Path:** `bun-type pollution in portable code`  
**Kind:** `failure_mode`

> Code written against `bun-types` globals (e.g., `Bun.file()`) will fail type-checking and at runtime if the project is ever run outside Bun without additional polyfills or type shims.

Code written against `bun-types` globals (e.g., `Bun.file()`) will fail type-checking and at runtime if the project is ever run outside Bun without additional polyfills or type shims.



