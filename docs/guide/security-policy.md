# Security policy

This is the project's vulnerability-reporting policy — how to report a security issue and
what's already hardened. For configuring the bridge's built-in security features (SSRF
protection, guardrails, RBAC), see **[Security →](/guide/security)** instead.

Mirrors the repo's root [`SECURITY.md`](https://github.com/CarlxsMG/mcpbridge/blob/main/SECURITY.md).

## Supported versions

MCP REST Bridge is currently released as a single version line. Security fixes are made
against the latest release only.

| Version | Supported |
| ------- | --------- |
| 1.0.0   | ✅        |
| < 1.0.0 | ❌        |

As the project matures past 1.0, this table will be expanded to reflect which major versions
receive backported security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/CarlxsMG/mcpbridge/security/advisories/new)
for this repository ("Security" tab → "Report a vulnerability"). This opens a private advisory
thread with maintainers only, so you can disclose details without a public issue.

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is ideal — this is a proxy/gateway, so request/response
  traces are especially useful)
- The version/commit you tested against
- Whether you believe it's exploitable pre-auth or requires an authenticated admin/session

We aim to acknowledge reports within a few business days and to keep you updated as we
investigate and fix the issue. Please give us reasonable time to ship a fix before any public
disclosure.

## What's already handled vs. what to flag

MCP REST Bridge has built-in defenses for a number of gateway-specific attack classes.
Familiarity with these helps you tell "expected hardening" from an actual bypass:

- **SSRF / DNS-rebinding protection.** Upstream registration resolves and _pins_ the target IP
  (including checks for IPv4-mapped IPv6, CGNAT ranges, and IPv6 unspecified/loopback
  addresses), so a bypass of this pinning is a high-priority report.
- **Secret encryption.** Upstream credentials (API keys, OAuth client secrets, etc.) are
  encrypted at rest (see `src/security/secret-box.ts`), not stored as plaintext config.
- **Tamper-evident audit log.** Admin and proxy actions are recorded in a hash-chained audit
  log; a way to break or silently rewrite that chain is a valid finding.
- **Session/auth hardening.** Session identifiers and auth comparisons use
  constant-time/hashed comparisons, refuse-to-start guards prevent booting with unsafe config
  (e.g. auth disabled outside development, wildcard CORS in production), and cookies are
  named/scoped based on the effective transport security.
- **Per-tool guardrails.** Rate limiting, circuit breaking, and RBAC are enforced per
  client/tool — a way to bypass these guards for a specific tool or client is worth reporting.

Things that are **not** yet hardened and are generally _not_ useful as security reports unless
they lead to a concrete exploit: missing linter/CI gates, best-practice nits without a
demonstrated impact, or denial-of-service via arbitrarily large self-inflicted load (unless it
crosses a trust boundary, e.g. an unauthenticated client exhausting resources meant to be
per-tenant-isolated).

## Scope

This policy covers the code in this repository (the gateway, the CLI, the admin UI, and the
database migration/persistence layer). Vulnerabilities in upstream dependencies should
generally be reported to those projects directly, but please let us know too if we're using
them in a way that's exploitable.

Next: **[Contributing →](/guide/contributing)** · **[Changelog →](/guide/changelog)**
