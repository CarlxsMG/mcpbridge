---
id: concept_9963b5242509ede0
kind: concept
source_path: layer cache optimisation
title: "Layer Cache Optimisation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.503Z
---

# Layer Cache Optimisation

**Path:** `layer cache optimisation`  
**Kind:** `concept`

> Copying only `package.json` and `bun.lock` before running `bun install` ensures the expensive install layer is cached and only rebuilt when dependencies change, not on every source code change.

Copying only `package.json` and `bun.lock` before running `bun install` ensures the expensive install layer is cached and only rebuilt when dependencies change, not on every source code change.
## Aliases

- `Docker layer caching`
- `cache invalidation`




