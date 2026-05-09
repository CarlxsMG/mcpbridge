---
id: failure_mode_57e3fd46babb9c1b
kind: failure_mode
source_path: session not persisted on initialize
title: "Session Not Persisted on Initialize"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.668Z
---

# Session Not Persisted on Initialize

**Path:** `session not persisted on initialize`  
**Kind:** `failure_mode`

> If transport.sessionId is null after handleRequest (e.g. SDK change), the new session is silently dropped; subsequent requests with a session ID get 404.

If transport.sessionId is null after handleRequest (e.g. SDK change), the new session is silently dropped; subsequent requests with a session ID get 404.



