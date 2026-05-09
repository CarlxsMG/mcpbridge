---
id: concept_e19cd41bf2dc85c9
kind: concept
source_path: date.now override
title: "Date.now Override"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.560Z
---

# Date.now Override

**Path:** `date.now override`  
**Kind:** `concept`

> Test technique: replaces global Date.now with a function returning realNow() + offset inside a try/finally block to simulate elapsed time for resetTimeoutMs checks without real delays.

Test technique: replaces global Date.now with a function returning realNow() + offset inside a try/finally block to simulate elapsed time for resetTimeoutMs checks without real delays.
## Aliases

- `time travel`
- `fake time`




