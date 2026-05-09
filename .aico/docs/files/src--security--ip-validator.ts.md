---
id: file_9b5eee6bd70c6cbe
kind: file
source_path: src/security/ip-validator.ts
title: "IP Validator — SSRF-Guard for Backend URL Validation"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.791Z
---

# IP Validator — SSRF-Guard for Backend URL Validation

**Path:** `src/security/ip-validator.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Guards against Server-Side Request Forgery (SSRF) by validating backend URLs before use. IPv4 addresses are converted to uint32 for efficient CIDR bitmask matching against six blocked private ranges (loopback, RFC-1918, link-local, APIPA). IPv6 blocking uses string-prefix heuristics covering loopback, ULA (fc/fd), and link-local (fe80–feb). The exported `validateBackendUrl` enforces HTTP/HTTPS-only protocols, an optional host allowlist, and DNS resolution via Bun's runtime API. Raw IP literals bypass DNS and are checked directly. For hostnames, every resolved record is screened; any private-range hit rejects the URL. The first resolved IP is returned as a pinned address to partially mitigate DNS rebinding attacks.

# `src/security/ip-validator.ts`

## Purpose

Prevents SSRF attacks by validating that a given backend URL does not resolve to a private, loopback, or link-local IP address. The module is consumed before any outbound HTTP request is made to a user-supplied or dynamically configured backend endpoint.

---

## Exports

### `validateBackendUrl(url, allowPrivateIps, allowedHosts): Promise<{ valid, reason?, resolvedIp? }>`

The sole public export. Validates a URL string end-to-end:

1. **URL parsing** — rejects malformed URLs immediately.
2. **Protocol guard** — only `http:` and `https:` are permitted.
3. **Allowlist check** — if `allowedHosts` is non-empty, the hostname must be present.
4. **IP literal detection** — raw IPv4 (`/^\d{1,3}(\.\d{1,3}){3}$/`) and IPv6 literals (bracket-wrapped or containing `:`) skip DNS and are checked directly via [[isPrivateIp]].
5. **DNS resolution** — hostnames are resolved via [[Bun.dns.lookup]] (IPv4 family only). All returned records are screened; any single private hit rejects the URL.
6. **IP pinning** — returns `resolvedIp` set to the first resolved address, giving callers a stable target that resists rebinding.

---

## Internal Helpers

### `ipv4ToUint32(ip: string): number | null`
Splits a dotted-quad string into four octets and packs them into a 32-bit unsigned integer via bitwise OR. Returns `null` for invalid input (wrong segment count, NaN, out-of-range octet). The `>>> 0` unsigned right-shift ensures JS sign-extension does not corrupt the result.

### `buildIpv4Range(cidr: string): Ipv4Range`
Parses a CIDR string into an [[Ipv4Range]] `{ base, mask }`. The mask is computed as `(~0 << (32 - prefixLen)) >>> 0`; prefix length 0 special-cases to mask `0` (matches everything). Assumes valid input — no error handling.

### `isBlockedIpv4(ip: string): boolean`
Checks whether a dotted-quad IP falls within any entry of [[BLOCKED_IPV4_RANGES]] using `(numeric & mask) === base`.

### `isBlockedIpv6(ip: string): boolean`
String-prefix heuristic covering:
- `::1` — loopback
- `fc…` / `fd…` — Unique Local Addresses (RFC 4193)
- `fe8…` / `fe9…` / `fea…` / `feb…` — link-local (fe80::/10)

Does **not** perform full 128-bit bitmask matching.

### `isPrivateIp(ip: string): boolean`
Dispatcher: delegates to [[isBlockedIpv6]] if the string contains `:`, otherwise [[isBlockedIpv4]].

---

## Blocked IPv4 CIDR Ranges (`BLOCKED_IPV4_RANGES`)

| CIDR | Description |
|---|---|
| `127.0.0.0/8` | Loopback |
| `10.0.0.0/8` | RFC-1918 class A |
| `172.16.0.0/12` | RFC-1918 class B |
| `192.168.0.0/16` | RFC-1918 class C |
| `169.254.0.0/16` | APIPA / link-local |
| `0.0.0.0/8` | "This" network |

---

## Key Flows

```
validateBackendUrl(url, allowPrivateIps, allowedHosts)
  ├─ parse URL               → invalid? reject
  ├─ check protocol          → non-http(s)? reject
  ├─ check allowedHosts      → not listed? reject
  ├─ detect IP literal?
  │   ├─ yes → isPrivateIp() → blocked? reject : { valid, resolvedIp }
  │   └─ no  → Bun.dns.lookup(hostname, { family: 4 })
  │               ├─ error / empty → reject
  │               └─ for each record: isPrivateIp() → blocked? reject
  └─ { valid: true, resolvedIp: results[0].address }
```

---

## Edge Cases & Gotchas

- **`allowPrivateIps: true`** disables all private-range checks — useful for local development but must never reach production without explicit gate.
- **`buildIpv4Range` panics silently**: if an invalid CIDR is passed (e.g., a bad IP part), `ipv4ToUint32` returns `null`, which is cast with `as number`, producing `NaN`-derived bitwise results. The pre-built constant list is safe, but extending `BLOCKED_IPV4_RANGES` requires care.
- **DNS is IPv4-only**: `Bun.dns.lookup` is called with `{ family: 4 }`. A hostname that resolves *exclusively* to IPv6 addresses returns an empty array and is rejected as unresolvable — which is safe but may cause false negatives.
- **IPv6 raw literals in URLs** are bracket-wrapped (`[::1]`); the code strips brackets before passing to [[isBlockedIpv6]].
- **Pinning is best-effort**: the caller receives `resolvedIp` but must use it when making the actual request. If it makes a fresh DNS lookup instead, rebinding protection is lost.

---

## References

### has_dep
- [other:Bun (Bun.dns.lookup)](../knowledge/deps/other-bun-bun-dns-lookup.md)

### has_failure_mode
- [allowPrivateIps Misconfiguration](../knowledge/failure-modes/allowprivateips-misconfiguration.md)
- [DNS Resolution Returns Only IPv6](../knowledge/failure-modes/dns-resolution-returns-only-ipv6.md)
- [DNS Rebinding Window](../knowledge/failure-modes/dns-rebinding-window.md)
- [Incomplete IPv6 Private Coverage](../knowledge/failure-modes/incomplete-ipv6-private-coverage.md)
- [buildIpv4Range Silent NaN on Bad CIDR](../knowledge/failure-modes/buildipv4range-silent-nan-on-bad-cidr.md)

### has_pattern
- [DNS Pinning (anti-rebinding)](../knowledge/patterns/dns-pinning-anti-rebinding.md)
- [Fail-Safe Default (deny private)](../knowledge/patterns/fail-safe-default-deny-private.md)
- [CIDR Bitmask Matching](../knowledge/patterns/cidr-bitmask-matching.md)
- [Allowlist-First Guard](../knowledge/patterns/allowlist-first-guard.md)

### references
- [Ipv4Range](../knowledge/concepts/ipv4range.md)

### uses_concept
- [ULA (Unique Local Address)](../knowledge/concepts/ula-unique-local-address.md)
- [SSRF (Server-Side Request Forgery)](../knowledge/concepts/ssrf-server-side-request-forgery.md)
- [Private IP Range](../knowledge/concepts/private-ip-range.md)
- [uint32 Bitmask](../knowledge/concepts/uint32-bitmask.md)
- [Ipv4Range](../knowledge/concepts/ipv4range.md)
- [DNS Rebinding](../knowledge/concepts/dns-rebinding.md)
- [Host Allowlist](../knowledge/concepts/host-allowlist.md)
- [CIDR Range](../knowledge/concepts/cidr-range.md)
- [Link-local Address](../knowledge/concepts/link-local-address.md)
- [IP Literal](../knowledge/concepts/ip-literal.md)

## Backlinks

### references
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### parent_of
- [src/security — SSRF Defense & Outbound URL Validation](../dirs/src--security.md)




