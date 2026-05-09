---
id: failure_mode_f12f16b44ad18519
kind: failure_mode
source_path: port env var not read by app
title: "PORT Env Var Not Read by App"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.757Z
---

# PORT Env Var Not Read by App

**Path:** `port env var not read by app`  
**Kind:** `failure_mode`

> If `src/index.ts` hardcodes the port rather than reading `process.env.PORT`, the `ENV PORT=3000` declaration is silently ignored and overriding the port at runtime has no effect.

If `src/index.ts` hardcodes the port rather than reading `process.env.PORT`, the `ENV PORT=3000` declaration is silently ignored and overriding the port at runtime has no effect.



