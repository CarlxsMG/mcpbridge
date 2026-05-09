---
id: pattern_554c2469ddc9fad7
kind: pattern
source_path: cleanup handle pattern
title: "Cleanup Handle Pattern"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.838Z
---

# Cleanup Handle Pattern

**Path:** `cleanup handle pattern`  
**Kind:** `pattern`

> setupTransports and startHealthCheckLoop both return teardown functions (cleanupTransports, stopHealthChecks) rather than exposing global state. Shutdown logic calls these handles in order, preventing resource leaks.

setupTransports and startHealthCheckLoop both return teardown functions (cleanupTransports, stopHealthChecks) rather than exposing global state. Shutdown logic calls these handles in order, preventing resource leaks.



