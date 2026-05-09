---
id: dir_83db56504c5b252d
kind: dir
source_path: src/security
title: "src/security — SSRF Defense & Outbound URL Validation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.612Z
---

# src/security — SSRF Defense & Outbound URL Validation

**Path:** `src/security`  
**Kind:** `dir`  
**Model:** `sonnet`

> The `src/security` directory provides Server-Side Request Forgery (SSRF) defenses for outbound backend URL validation. Its core module blocks private IP ranges using uint32 CIDR bitmask matching for IPv4 (loopback, RFC-1918, link-local, APIPA) and string-prefix heuristics for IPv6 (loopback, ULA fc/fd, link-local fe80–feb). Protocol enforcement restricts requests to HTTP/HTTPS only. An optional host allowlist enables explicit access control. DNS resolution via Bun's runtime API screens every resolved record for hostname inputs; raw IP literals bypass DNS and are validated directly. The first resolved IP is pinned as the connection target to partially mitigate DNS rebinding. Any private-range hit causes immediate rejection.

# src/security

## Purpose
Centralizes network-layer security primitives that guard the application against **Server-Side Request Forgery (SSRF)** — the class of attack where an adversary causes the server to issue requests to internal or otherwise forbidden network addresses.

---

## Modules

### `ip-validator.ts`
The sole module in this directory; it exports the primary entry point **`validateBackendUrl`**.

#### Validation Pipeline
1. **Protocol check** — Only `http:` and `https:` schemes are accepted; all others are rejected immediately.
2. **Host allowlist** — An optional caller-supplied set of permitted hostnames is consulted before further resolution; non-listed hosts are denied when the allowlist is active.
3. **Raw IP literal path** — If the URL host is already an IP address, DNS resolution is skipped; the address is fed directly into the private-range checker.
4. **Hostname DNS resolution** — Bun's runtime DNS API resolves the hostname; **every returned record** (A and AAAA) is screened. A single private-range hit rejects the entire URL.
5. **Address pinning** — The first resolved IP is returned alongside validation success, acting as a pinned address to harden against DNS rebinding between validation and connection time.

#### Private-Range Detection
| Address Family | Method | Ranges Covered |
|---|---|---|
| IPv4 | uint32 CIDR bitmask | Loopback (127/8), RFC-1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16), APIPA |
| IPv6 | String-prefix heuristic | Loopback (`::1`), ULA (`fc`, `fd`), link-local (`fe80`–`feb`) |

---

## Security Properties
- **Completeness** — Both resolved and literal IPs are checked; no path skips the range validator.
- **Defence-in-depth** — The allowlist layer sits above IP checks, enabling strict whitelisting independent of IP analysis.
- **Partial DNS-rebinding mitigation** — Pinning the first resolved IP reduces (but does not eliminate) the rebinding window.

## Dependencies
- **Bun runtime DNS API** — Resolution is Bun-specific; the module is not portable to Node.js without adaptation.
## Domains

- `security`
- `networking`
- `ssrf-protection`
- `input-validation`
- `dns`


---

## Backlinks

### child_of
- [IP Validator — SSRF-Guard for Backend URL Validation](../files/src--security--ip-validator.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](src.md)




