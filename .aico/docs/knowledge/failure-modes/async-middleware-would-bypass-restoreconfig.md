---
id: failure_mode_74ec810ffe1e57bb
kind: failure_mode
source_path: async middleware would bypass restoreconfig
title: "Async middleware would bypass restoreConfig"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.684Z
---

# Async middleware would bypass restoreConfig

**Path:** `async middleware would bypass restoreconfig`  
**Kind:** `failure_mode`

> If adminAuth or mcpAuth became async, restoreConfig() called synchronously after the invocation would run before the middleware's awaited logic, leaving config mutated during actual execution.

If adminAuth or mcpAuth became async, restoreConfig() called synchronously after the invocation would run before the middleware's awaited logic, leaving config mutated during actual execution.



