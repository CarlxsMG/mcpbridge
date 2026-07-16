# Security

Security is built into MCP REST Bridge's default path, not bolted on. Because the bridge
calls backends _on behalf of_ AI clients, it defends both directions: it stops the bridge
from being turned into an attack tool (SSRF), and it stops untrusted backend output from
steering the model (prompt injection).

## Network egress (SSRF & DNS rebinding)

- Every backend URL — REST base/health URLs and MCP upstream URLs — is validated **before
  registration** and blocked if it resolves to a private/loopback/link-local address
  (unless `ALLOW_PRIVATE_IPS=true`, intended for local dev only).
- The resolved IP is **pinned**, so a later DNS change can't redirect an already-registered
  backend to an internal host (DNS-rebinding protection).
- DNS resolution uses Bun's resolver directly for structured, spoof-resistant results.

## Browser-facing request validation

- **CORS allowlisting** — the admin API rejects cross-origin requests outside an explicit
  allowlist; wildcard origins are never combined with credentialed requests.
- **Origin / Sec-Fetch-Site validation** — every MCP transport endpoint (including raw
  WebSocket upgrades) enforces the MCP spec's origin checks, independently of CORS.
- **JSON depth limiting** — incoming request bodies are checked against a configurable maximum
  nesting depth, blocking deeply-nested-payload denial-of-service attempts before they reach
  application code.

## Content guardrails

Per-tool guardrails — input deny-rules, secret detection, response sanitizing, field
redaction — scan both directions of every call, and run **before** the circuit breaker so a
rejected call never consumes a breaker probe slot. See
**[Guardrails & resilience →](/guide/guardrails-resilience)** for the full set.

## Access control

Admin RBAC (`admin` / `operator` / `auditor` / `viewer`), MCP API keys (scoped, hashed,
fail-closed allowed-key restrictions), and team multi-tenancy gate who can administer the
bridge and who can call which tools. See
**[Access control & multi-tenancy →](/guide/access-control)** for roles, key scoping and
team isolation.

## Tamper-evident audit

Every admin mutation is written to a **hash-chained** audit log
(`hash = SHA256(JSON.stringify([prev_hash, actor, action, target, detail, created_at]))`) —
a JSON-encoded pre-image rather than a bare delimiter join, since caller-influenced fields
like `target` and `detail` could otherwise collide across distinct rows — so any
retroactive edit or deletion breaks the chain and is detectable via a verify endpoint.
Events can also be streamed to a SIEM in real time (`AUDIT_SINK_URL`).

## Hardening checklist for production

- Serve over **HTTPS** and leave `SESSION_COOKIE_SECURE=true` (cookies become `__Host-`/Secure).
- Set strong `MCP_API_KEYS` and, where relevant, per-tool allowed-key restrictions.
- Keep `ALLOW_PRIVATE_IPS` **unset** (production backends should be public or explicitly allow-listed).
- Only enable `TRUST_PROXY` when actually behind a trusted reverse proxy.
- Never run with auth disabled outside local development.

See **[Configuration →](/guide/configuration)** for every relevant setting.
