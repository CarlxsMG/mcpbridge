---
id: failure_mode_c6c0665a1f05adfe
kind: failure_mode
source_path: native addon musl incompatibility
title: "Native Addon musl Incompatibility"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.735Z
---

# Native Addon musl Incompatibility

**Path:** `native addon musl incompatibility`  
**Kind:** `failure_mode`

> A dependency ships a prebuilt `.node` binary compiled for glibc; Alpine's musl libc cannot load it, causing a runtime crash that is not caught at build time.

A dependency ships a prebuilt `.node` binary compiled for glibc; Alpine's musl libc cannot load it, causing a runtime crash that is not caught at build time.



