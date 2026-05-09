---
id: concept_13465f52e6007edf
kind: concept
source_path: adminauth
title: "adminAuth"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.356Z
---

# adminAuth

**Path:** `adminauth`  
**Kind:** `concept`

> Express middleware that validates a Bearer token against the configured adminApiKeys list. Returns 401 for missing/malformed headers and 403 for unrecognized tokens.

Express middleware that validates a Bearer token against the configured adminApiKeys list. Returns 401 for missing/malformed headers and 403 for unrecognized tokens.
## Aliases

- `admin middleware`
- `admin Bearer auth`




