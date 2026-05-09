---
id: pattern_16534ce7ab36f99e
kind: pattern
source_path: bundler-aligned module resolution
title: "Bundler-aligned module resolution"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.818Z
---

# Bundler-aligned module resolution

**Path:** `bundler-aligned module resolution`  
**Kind:** `pattern`

> Using `moduleResolution: bundler` keeps TypeScript's import resolution in sync with the actual bundler (Bun), preventing false-positive type errors on valid imports and ensuring `package.json` exports fields are respected.

Using `moduleResolution: bundler` keeps TypeScript's import resolution in sync with the actual bundler (Bun), preventing false-positive type errors on valid imports and ensuring `package.json` exports fields are respected.



