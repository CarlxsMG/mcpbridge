---
id: pattern_7246f90054a2ff3f
kind: pattern
source_path: dependency-layer separation
title: "Dependency-Layer Separation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.861Z
---

# Dependency-Layer Separation

**Path:** `dependency-layer separation`  
**Kind:** `pattern`

> Copying only the manifest/lockfile before `bun install` isolates the expensive install step into its own cache layer, which is invalidated only on dependency changes — not on every source edit.

Copying only the manifest/lockfile before `bun install` isolates the expensive install step into its own cache layer, which is invalidated only on dependency changes — not on every source edit.



