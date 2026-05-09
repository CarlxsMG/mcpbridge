---
id: failure_mode_d5f7edd4ba3e335f
kind: failure_mode
source_path: custom config untestable via factory
title: "Custom Config Untestable via Factory"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.749Z
---

# Custom Config Untestable via Factory

**Path:** `custom config untestable via factory`  
**Kind:** `failure_mode`

> getCircuitBreaker always applies default config; because the CircuitBreaker constructor is not exported, tests cannot verify behaviour at non-default thresholds or timeouts without source changes.

getCircuitBreaker always applies default config; because the CircuitBreaker constructor is not exported, tests cannot verify behaviour at non-default thresholds or timeouts without source changes.



