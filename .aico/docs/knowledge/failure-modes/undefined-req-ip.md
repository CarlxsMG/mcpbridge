---
id: failure_mode_8279bcfebe040ad6
kind: failure_mode
source_path: undefined req.ip
title: "Undefined req.ip"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.688Z
---

# Undefined req.ip

**Path:** `undefined req.ip`  
**Kind:** `failure_mode`

> Express trust proxy not configured or reverse proxy strips IP headers. Falls back to req.socket.remoteAddress then '127.0.0.1', potentially misidentifying the caller.

Express trust proxy not configured or reverse proxy strips IP headers. Falls back to req.socket.remoteAddress then '127.0.0.1', potentially misidentifying the caller.



