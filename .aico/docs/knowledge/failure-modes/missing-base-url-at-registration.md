---
id: failure_mode_0255a1cc4782deb5
kind: failure_mode
source_path: missing base_url at registration
title: "Missing base_url at registration"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.619Z
---

# Missing base_url at registration

**Path:** `missing base_url at registration`  
**Kind:** `failure_mode`

> base_url is optional in RegistrationPayload but required in RegisteredClient; if the gateway cannot derive it from context, registration may silently produce an invalid client.

base_url is optional in RegistrationPayload but required in RegisteredClient; if the gateway cannot derive it from context, registration may silently produce an invalid client.



