---
id: failure_mode_040cb5ae85494e22
kind: failure_mode
source_path: uncleared setinterval blocking shutdown
title: "Uncleared setInterval Blocking Shutdown"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.619Z
---

# Uncleared setInterval Blocking Shutdown

**Path:** `uncleared setinterval blocking shutdown`  
**Kind:** `failure_mode`

> The idle-eviction interval is registered at module load with no handle stored and no teardown path. In test suites or short-lived processes, the dangling timer prevents the event loop from draining.

The idle-eviction interval is registered at module load with no handle stored and no teardown path. In test suites or short-lived processes, the dangling timer prevents the event loop from draining.



