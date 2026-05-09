---
id: failure_mode_2b671eafe49dd4d3
kind: failure_mode
source_path: auth bypass in production
title: "Auth bypass in production"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.646Z
---

# Auth bypass in production

**Path:** `auth bypass in production`  
**Kind:** `failure_mode`

> AUTH_DISABLED=true left enabled outside development disables both AdminAuth and McpAuth, exposing registration and MCP traffic without a bearer token.

AUTH_DISABLED=true left enabled outside development disables both AdminAuth and McpAuth, exposing registration and MCP traffic without a bearer token.



