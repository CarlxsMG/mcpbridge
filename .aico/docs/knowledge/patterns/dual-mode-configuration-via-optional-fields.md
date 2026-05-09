---
id: pattern_a2cfec52fc8399c0
kind: pattern
source_path: dual-mode configuration via optional fields
title: "Dual-Mode Configuration via Optional Fields"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.878Z
---

# Dual-Mode Configuration via Optional Fields

**Path:** `dual-mode configuration via optional fields`  
**Kind:** `pattern`

> RegistrationPayload uses optional fields to express two mutually exclusive modes (manual vs. OpenAPI). Keeps the payload shape flat and simple but shifts validation of mutual exclusivity to runtime.

RegistrationPayload uses optional fields to express two mutually exclusive modes (manual vs. OpenAPI). Keeps the payload shape flat and simple but shifts validation of mutual exclusivity to runtime.



