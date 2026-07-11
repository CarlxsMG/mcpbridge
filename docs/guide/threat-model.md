# Threat model

This page states the trust boundaries MCP REST Bridge is designed around, the attacker
capabilities it defends against at each one, and — just as importantly — what is **out of
scope**. It complements the hardened-by-default behaviour listed in
[Security →](/guide/security) and the vulnerability process in
[Security policy →](/guide/security-policy).

## Assets worth protecting

- **Backend credentials** — upstream API keys, OAuth2 client secrets, and the injected
  `Authorization` the gateway adds on the caller's behalf. A tool caller must never see them.
- **Admin control** — the ability to register backends, mint keys, edit guards, or read the
  audit log.
- **Tenant isolation** — a team-scoped operator must not see or act on another team's clients.
- **Audit integrity** — the tamper-evident record of every admin mutation.
- **The internal network** — the gateway sits next to services a public caller can't reach.

## Trust boundaries

### 1. MCP client → gateway (data plane)

**Crosses it:** tool-call JSON-RPC over `POST /mcp/:client` and `/mcp-custom/:bundle` (and the
WS proxy). **Attacker:** anyone who can reach the endpoint; a caller with a scoped key trying
to exceed its scope; a malicious tool argument.

- Bearer MCP key or OAuth2/OIDC JWT, constant-time compared (`safeCompare`); keys can be scoped
  to specific clients/tools, expiring, revocable. `REQUIRE_MCP_AUTH=true` fails closed even
  before any key exists.
- Origin validation on browser-originating requests; per-session rate limits; a bounded request
  body (64 kb) and JSON-depth cap.
- Input guardrails (deny-rules, secret detection) run before dispatch; non-idempotent methods
  are never retried.

**Residual risk:** if no auth material is configured and `REQUIRE_MCP_AUTH` is unset, the data
plane is open (a loud boot warning is logged). A key holder can call any tool inside its scope.

### 2. Operator/admin → gateway (control plane + admin API)

**Crosses it:** `POST /mcp` (`sys_*` tools) and `/admin-api/*`. **Attacker:** a lower-privilege
admin trying to escalate; a stolen session; CSRF from a malicious page.

- `/mcp` control plane is **fail-closed** (`rootMcpAuth`) — no "unconfigured means open"
  fallback; a caller must resolve to a real system role, and sensitive tools require step-up.
- Admin API: static Bearer key **or** argon2id session login; RBAC (`admin`/`operator`/
  `auditor`/`viewer`) enforced per route; cookie-authenticated mutations require a matching
  `X-CSRF-Token`; login is rate-limited and anti-enumeration.
- Team multi-tenancy scopes every client route (`ensureClientAccess`), including bulk operations.

**Residual risk:** a leaked static `ADMIN_API_KEYS` value is full admin (rotate on suspicion).
`AUTH_DISABLED=true` disables all of this — it refuses to start outside development.

### 3. Gateway → backend (outbound)

**Crosses it:** the proxied HTTP/WS/GraphQL call to your upstream. **Attacker:** a registered
URL aimed at the internal network or cloud metadata (SSRF); DNS rebinding; an open redirect.

- Every backend URL (`health_url`, `base_url`, `openapi_url`, `graphql_url`, `mcp_url`, WS,
  canary, LB-pool, webhooks, OAuth token) is validated by `validateBackendUrl`, and its
  resolved IP is **pinned** at registration and never re-resolved.
- Outbound fetches use the pinned IP, send the original hostname as `Host`, and set
  `redirect: "error"`. Loopback/private ranges are rejected unless `ALLOW_PRIVATE_IPS=true`
  (dev only). Auto-pagination follows only same-host, re-pinned URLs.

**Residual risk:** a backend that is itself compromised can return malicious data (see
boundary 5). Pinning trusts the IP resolved at registration time.

### 4. Gateway → storage (at rest)

**Crosses it:** the `bun:sqlite` file. **Attacker:** someone with read (or write) access to the
DB file or a backup.

- Upstream secrets are AES-256-GCM encrypted at rest (or delegated to a Vault Transit key); read
  models never return them. API keys and session tokens are stored as SHA-256 hashes, passwords
  as argon2id. The audit log is hash-chained (verifiable) and can be streamed to a SIEM.

**Residual risk:** the audit hash-chain is tamper-**evident**, not tamper-**resistant** — an
attacker with DB write access can rewrite history consistently (mitigate by streaming to an
append-only SIEM). Encryption is only as strong as `SECRET_ENCRYPTION_KEY`'s custody.

### 5. Untrusted content → the LLM (prompt injection)

**Crosses it:** tool descriptions discovered from a spec, and backend responses returned to the
model. **Attacker:** a malicious or compromised backend trying to steer the calling agent.

- Tool descriptions are sanitized (`sanitizeToolDescription`) before entering the registry.
- Response guardrails scan for secret leakage and wrap untrusted responses in a safe envelope;
  declarative redaction can strip fields.

**Residual risk:** prompt injection is not fully solvable at the gateway — the model may still
act on adversarial content. Treat backends as semi-trusted and keep tool scopes least-privilege.

## Explicitly out of scope

- **A compromised host / root on the box** — full DB and key-material access is game over; run
  the gateway as the isolated, non-root process it ships as.
- **Backend-side vulnerabilities** — the gateway governs access; it can't make an insecure
  backend secure.
- **Denial of service at the network edge** — rate limits bound per-caller cost, but front the
  gateway with a real WAF/LB for volumetric protection.
- **A hostile administrator** — RBAC limits _lower_-privilege roles; a full `admin` is trusted.

Next: **[Security →](/guide/security)** · **[Security policy →](/guide/security-policy)**
