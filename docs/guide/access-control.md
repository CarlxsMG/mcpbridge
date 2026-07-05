# Access control & multi-tenancy

The bridge separates **who administers it** (admin users, roles) from **who calls tools**
(MCP API keys / JWTs, scoped to consumers and teams).

## Admin roles (RBAC)

Admin users sign in to the Vue admin UI; every mutating action is role-gated and audited.

| Role       | Can do                                                                     |
| ---------- | -------------------------------------------------------------------------- |
| `admin`    | Everything, including managing users, teams and global config              |
| `operator` | Register/configure backends, guards, bundles, keys — day-to-day operations |
| `auditor`  | Read-only plus the audit log and its integrity check                       |
| `viewer`   | Read-only dashboards                                                       |

Programmatic/CI callers can use a static `ADMIN_API_KEYS` Bearer token instead of a session;
Bearer calls are exempt from CSRF (they aren't cookie-based).

Admins can also sign in via **SSO** (OIDC Authorization Code + PKCE) instead of a local
password — a separate inbound-auth surface from the MCP data plane's JWT/API-key auth below.
Auto-provisioned SSO users are always assigned the `viewer` role. Any authenticated admin can
list and remotely revoke their own active sessions, and change their own password (which
revokes every other session) — no superadmin needed for either.

## MCP API keys

Keys are what tool callers present. They're stored hashed (never in plaintext) and the raw
value is shown exactly once at creation.

- **Scoped** — restrict a key to specific clients and/or tools.
- **Elevated** — mark a key as allowed to call tools flagged sensitive/elevated.
- **Lifecycle** — set an expiry, revoke instantly, see last-used timestamps.
- **Fail-closed** — a per-tool allowed-key restriction is enforced even if global auth is
  disabled: configuring one clearly signals intent.

## Consumers & quotas

Group keys under a **consumer** (a team, product, or tenant) and give it a **monthly quota**.
Usage is tracked per consumer so you can see who's spending calls and cap them.

## Teams (multi-tenancy)

**Teams** scope clients so tenants only see and manage their own backends. A bearer
super-admin sees everything; a session user with no team is a super-admin; a team-scoped
user is limited to their team. Cross-team access returns the same "not found" response as a
missing resource, so team membership never leaks through error shapes.

## Inbound JWT / OAuth

Set `JWT_JWKS_URL` to accept OAuth2/OIDC access tokens as an MCP credential, verified against
a JWKS endpoint (RS256/ES256 via WebCrypto — no extra dependency). Optionally pin `JWT_ISSUER`
and `JWT_AUDIENCE`. This is additive to `MCP_API_KEYS` and DB-managed keys.

Next: **[Guardrails & resilience →](/guide/guardrails-resilience)** ·
**[Security →](/guide/security)**
