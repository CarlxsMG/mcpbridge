---
id: pattern_70881e059daded4b
kind: pattern
source_path: circuit breaker state machine
title: "Circuit Breaker State Machine"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.853Z
---

# Circuit Breaker State Machine

**Path:** `circuit breaker state machine`  
**Kind:** `pattern`

> Three-state FSM (closed → open → half_open → closed/open) prevents cascading failures by short-circuiting requests to a degraded dependency and auto-recovering after a cooldown.

Three-state FSM (closed → open → half_open → closed/open) prevents cascading failures by short-circuiting requests to a degraded dependency and auto-recovering after a cooldown.



