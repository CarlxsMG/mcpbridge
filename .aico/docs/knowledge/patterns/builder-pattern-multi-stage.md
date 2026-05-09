---
id: pattern_c27dec95a349f4a1
kind: pattern
source_path: builder pattern (multi-stage)
title: "Builder Pattern (Multi-Stage)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.886Z
---

# Builder Pattern (Multi-Stage)

**Path:** `builder pattern (multi-stage)`  
**Kind:** `pattern`

> A dedicated `deps` stage installs all tooling and produces `node_modules`; the final stage pulls only the artifact. Build-time tools and intermediate files never enter the shipped image.

A dedicated `deps` stage installs all tooling and produces `node_modules`; the final stage pulls only the artifact. Build-time tools and intermediate files never enter the shipped image.



