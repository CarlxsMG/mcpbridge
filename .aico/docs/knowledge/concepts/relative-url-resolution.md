---
id: concept_8a268f8c55c49acb
kind: concept
source_path: relative url resolution
title: "Relative URL Resolution"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.484Z
---

# Relative URL Resolution

**Path:** `relative url resolution`  
**Kind:** `concept`

> health_url and openapi_url values not starting with 'http' are resolved to absolute URLs using the requester's IP address extracted from req.ip or req.socket.remoteAddress.

health_url and openapi_url values not starting with 'http' are resolved to absolute URLs using the requester's IP address extracted from req.ip or req.socket.remoteAddress.
## Aliases

- `URL normalization`




