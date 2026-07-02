# Security

Security is built into MCP REST Bridge's default path, not bolted on. Because the bridge
calls backends *on behalf of* AI clients, it defends both directions: it stops the bridge
from being turned into an attack tool (SSRF), and it stops untrusted backend output from
steering the model (prompt injection).

## Network egress (SSRF & DNS rebinding)

- Every backend URL — REST base/health URLs and MCP upstream URLs — is validated **before
  registration** and blocked if it resolves to a private/loopback/link-local address
  (unless `ALLOW_PRIVATE_IPS=true`, intended for local dev only).
- The resolved IP is **pinned**, so a later DNS change can't redirect an already-registered
  backend to an internal host (DNS-rebinding protection).
- DNS resolution uses Bun's resolver directly for structured, spoof-resistant results.

## Content guardrails

Per tool, you can enable:

- **Input deny-rules** — reject calls whose arguments match configured patterns.
- **Secret detection** — block requests that appear to carry credentials/tokens.
- **Response sanitizing** — scan backend responses for prompt-injection payloads and wrap
  untrusted data in a safe envelope before returning it to the model.
- **Field redaction** — strip sensitive fields from responses.

Guardrails run inside dispatch **before** the circuit breaker, so a rejected call never
consumes a breaker probe slot.

## Access control

- **MCP API keys** gate tool calls, and can be **scoped** to specific clients/tools; keys
  are stored as hashes, never in plaintext, and the raw key is shown exactly once.
- **Per-tool allowed-key** restrictions are **fail-closed** — enforced even if global auth
  is disabled, because an admin who set one clearly wants it.
- **Admin RBAC** — `admin` / `operator` / `auditor` / `viewer` roles gate the admin UI and
  API. Admin login uses argon2id password hashing; sessions are cookie-based with CSRF
  protection on mutating requests, while programmatic callers use static Bearer keys.
- **Team multi-tenancy** scopes clients to teams so tenants only see their own resources,
  with identical “not found” responses on cross-team access to avoid information leaks.

## Tamper-evident audit

Every admin mutation is written to a **hash-chained** audit log
(`hash = SHA256(prev_hash | actor | action | target | detail | created_at)`), so any
retroactive edit or deletion breaks the chain and is detectable via a verify endpoint.
Events can also be streamed to a SIEM in real time (`AUDIT_SINK_URL`).

## Hardening checklist for production

- Serve over **HTTPS** and leave `SESSION_COOKIE_SECURE=true` (cookies become `__Host-`/Secure).
- Set strong `MCP_API_KEYS` and, where relevant, per-tool allowed-key restrictions.
- Keep `ALLOW_PRIVATE_IPS` **unset** (production backends should be public or explicitly allow-listed).
- Only enable `TRUST_PROXY` when actually behind a trusted reverse proxy.
- Never run with auth disabled outside local development.

See **[Configuration →](/guide/configuration)** for every relevant setting.
