/** Centralised SSRF-defence IP validator. */

import ipaddr from "ipaddr.js";

// ---------------------------------------------------------------------------
// IPv4 CIDR block list — all entries include a human-readable label.
// ---------------------------------------------------------------------------

/** Named list of blocked IPv4 CIDRs. No magic strings elsewhere in this file. */
const BLOCKED_IPV4_CIDRS: readonly [string, string][] = [
  ["127.0.0.0/8", "loopback"],
  ["10.0.0.0/8", "RFC-1918 class-A private"],
  ["172.16.0.0/12", "RFC-1918 class-B private"],
  ["192.168.0.0/16", "RFC-1918 class-C private"],
  ["169.254.0.0/16", "link-local"],
  ["0.0.0.0/8", "unspecified / this-network"],
  ["100.64.0.0/10", "CGNAT (RFC-6598)"],
  ["192.0.0.0/24", "IETF protocol assignments (RFC-6890)"],
  ["192.0.2.0/24", "TEST-NET-1 (RFC-5737)"],
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Pre-parse CIDR ranges once at module load for IPv4 matching.
const BLOCKED_IPV4_PARSED: Array<[ipaddr.IPv4, number]> = BLOCKED_IPV4_CIDRS.map(([cidr]) =>
  ipaddr.IPv4.parseCIDR(cidr),
);

function isBlockedIpv4(ip: string): boolean {
  let parsed: ipaddr.IPv4;
  try {
    parsed = ipaddr.IPv4.parse(ip);
  } catch {
    return false;
  }
  return BLOCKED_IPV4_PARSED.some((range) => parsed.match(range));
}

/**
 * IPv6 SSRF-defence using ipaddr.js range classification.
 *
 * Blocked named ranges (via ipaddr.js built-in range table):
 *   loopback      → ::1/128
 *   unspecified   → ::/128
 *   linkLocal     → fe80::/10
 *   uniqueLocal   → fc00::/7
 *   reserved      → includes documentation (2001:db8::/32), discard (100::/64)
 *   ipv4Mapped    → ::ffff:0:0/96  — extract embedded v4 and re-validate
 *   rfc6052       → 64:ff9b::/96 (NAT64) — extract embedded v4 and re-validate
 *   6to4          → 2002::/16 — extract embedded v4 from bits 16-47 and re-validate
 */
function isBlockedIpv6(ip: string): boolean {
  let parsed: ipaddr.IPv6;
  try {
    parsed = ipaddr.IPv6.parse(ip);
  } catch {
    return false;
  }

  const range = parsed.range();

  // Ranges that are always blocked outright.
  const blockedRanges: string[] = [
    "loopback",
    "unspecified",
    "linkLocal",
    "uniqueLocal",
    "reserved", // covers 2001:db8::/32 (documentation), 100::/64 (discard), and others
    "multicast",
  ];
  if (blockedRanges.includes(range)) return true;

  // IPv4-mapped (::ffff:0:0/96) — extract embedded IPv4 and re-validate.
  if (range === "ipv4Mapped") {
    try {
      const embedded = parsed.toIPv4Address().toString();
      return isBlockedIpv4(embedded);
    } catch {
      return true; // can't extract → block
    }
  }

  // NAT64 (64:ff9b::/96, rfc6052) — last 32 bits are the embedded IPv4.
  if (range === "rfc6052") {
    try {
      const parts = parsed.parts; // 8 x 16-bit groups
      const hi = parts[6];
      const lo = parts[7];
      const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIpv4(embedded);
    } catch {
      return true;
    }
  }

  // 6to4 (2002::/16) — the embedded IPv4 sits in bits 16-47:
  // parts[1] carries its high 16 bits, parts[2] the low 16 bits.
  if (range === "6to4") {
    try {
      const parts = parsed.parts;
      const hi = parts[1]; // bits 16-31 of the address
      const lo = parts[2]; // bits 32-47
      const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIpv4(embedded);
    } catch {
      return true;
    }
  }

  return false;
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    return isBlockedIpv6(ip);
  }
  return isBlockedIpv4(ip);
}

/**
 * True when `hostname` is already an IP literal (dotted-quad IPv4, or IPv6 —
 * bracketed `[::1]` or bare `::1`) rather than a DNS name. This is the single
 * canonical check shared by `validateBackendUrl` below (to decide whether to
 * skip DNS resolution) and by every pinning call site that needs to skip
 * DNS resolution / TTL re-pinning for a literal whose trust was already
 * established once, at validation time (proxy.ts, ws-proxy.ts).
 */
export function isRawIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
}

export async function validateBackendUrl(
  url: string,
  allowPrivateIps: boolean,
  allowedHosts: string[],
): Promise<{ valid: true; resolvedIp: string } | { valid: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: `Protocol not allowed: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    return { valid: false, reason: `Host not in allowedHosts: ${hostname}` };
  }

  // Always resolve DNS to pin the IP, unless it is already a raw IP address.
  const isRawIpv6 = hostname.startsWith("[") || hostname.includes(":");

  if (isRawIpLiteral(hostname)) {
    // Already an IP literal — use it directly as the pinned address.
    const rawIp = isRawIpv6 ? hostname.replace(/^\[|\]$/g, "") : hostname;
    if (!allowPrivateIps && isPrivateIp(rawIp)) {
      return { valid: false, reason: `IP is in a blocked private range: ${rawIp}` };
    }
    return { valid: true, resolvedIp: rawIp };
  }

  // Dual-stack DNS resolution — validate EVERY record from both A and AAAA.
  // If ANY single record is blocked → reject the whole hostname (DNS rebinding defence).
  const [v4Result, v6Result] = await Promise.allSettled([
    Bun.dns.lookup(hostname, { family: 4 }),
    Bun.dns.lookup(hostname, { family: 6 }),
  ]);

  const v4Records: { address: string }[] = v4Result.status === "fulfilled" ? v4Result.value : [];
  const v6Records: { address: string }[] = v6Result.status === "fulfilled" ? v6Result.value : [];

  const allRecords = [...v4Records, ...v6Records];

  if (allRecords.length === 0) {
    return { valid: false, reason: `DNS resolution failed for: ${hostname}` };
  }

  for (const record of allRecords) {
    if (!allowPrivateIps && isPrivateIp(record.address)) {
      return { valid: false, reason: `Resolved IP is in a blocked private range: ${record.address}` };
    }
  }

  // Prefer v4 for the pinned IP (matches existing caller expectations in proxy.ts).
  const pinnedIp = v4Records.length > 0 ? v4Records[0].address : v6Records[0].address;
  return { valid: true, resolvedIp: pinnedIp };
}

// ---------------------------------------------------------------------------
// TTL-based re-resolution — mitigates IP-pin TOCTOU / DNS-rebinding
// ---------------------------------------------------------------------------

/** 5-minute re-resolution TTL. Change via IP_PIN_TTL_MS export if needed. */
export const IP_PIN_TTL_MS = 5 * 60 * 1000;

/** A pinned IP address together with the timestamp at which it was resolved. */
export interface PinnedIp {
  ip: string;
  resolvedAt: number; // Date.now() at last successful resolve
}

/**
 * Re-resolves `hostname` through the existing dual-stack SSRF validator when
 * the pin is older than `IP_PIN_TTL_MS`.  Returns the current pin unchanged
 * when still within the TTL window.
 *
 * Throws when the freshly resolved IP lands in a blocked private range so the
 * caller can reject the request.
 */
export async function refreshPinIfStale(
  hostname: string,
  current: PinnedIp,
  now: number = Date.now(),
): Promise<PinnedIp> {
  if (now - current.resolvedAt < IP_PIN_TTL_MS) return current;

  // Re-resolve via the existing dual-stack validator (allowPrivateIps=false, no host filter).
  const result = await validateBackendUrl(`http://${hostname}/`, false, []);

  if (!result.valid) {
    throw new Error(`Backend hostname now resolves to private IP or failed DNS: ${result.reason ?? hostname}`);
  }

  return { ip: result.resolvedIp, resolvedAt: now };
}

// ---------------------------------------------------------------------------
// Pin-preserving transport helpers — swap the connection target to a
// validated IP while keeping the original hostname visible to the upstream
// (Host header / TLS SNI), for the two distinct transport mechanisms used by
// call sites across the codebase: a wrapped `fetch` (mcp-upstream.ts's MCP-SDK
// client transports) and a `dns.lookup`-shaped override (ws-proxy.ts's raw
// WebSocket dial, which can't rewrite the request URL the way fetch does).
// ---------------------------------------------------------------------------

export type PinnedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Builds a fetch that pins `originalHostname` to `ip` while preserving the
 * original Host header — the same DNS-rebinding mitigation applied at every
 * other pinned call site, adapted for callers that hand a transport its own
 * `fetch` implementation (e.g. the MCP SDK's HTTP/SSE transports) instead of
 * building the request URL themselves.
 */
export function makePinnedFetch(originalHostname: string, ip: string, baseFetch: typeof fetch = fetch): PinnedFetch {
  return async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    const host = u.host; // host:port, preserved as the Host header
    if (u.hostname === originalHostname) {
      u.hostname = ip;
    }
    const headers = new Headers(init?.headers);
    headers.set("Host", host);
    return baseFetch(u, { ...init, headers, redirect: "error" });
  };
}

/**
 * A WebSocket dial pinned to a validated IP: `url` is what to actually open
 * (connect host rewritten to the IP literal, so no DNS resolution happens at
 * dial time), and `options` are the `ws` options that keep the original
 * hostname visible to the backend (Host header, plus TLS SNI for `wss`).
 */
export interface PinnedWsDial {
  url: string;
  options: { headers?: Record<string, string>; servername?: string };
}

/**
 * Pins a WebSocket dial to `ip` the way {@link makePinnedFetch} pins a fetch:
 * rewrite the connect host to the validated IP literal — so the hostname is
 * never resolved at dial time, closing the DNS-rebinding TOCTOU window — while
 * carrying the original hostname in the `Host` header, and the TLS SNI
 * (`servername`) for `wss`, so the backend still sees (and its certificate
 * still validates against) its own name.
 *
 * This replaces an earlier `dns.lookup`-override approach: **Bun's `ws` shim
 * silently ignores the `lookup` option**, so under this project's runtime a
 * `{ lookup }` pin was a no-op and provided NO actual protection. A raw-IP URL
 * already dials a literal and is returned unchanged (no override needed).
 */
export function pinnedWsDial(wsUrl: string, ip: string): PinnedWsDial {
  const u = new URL(wsUrl.replace(/^ws/, "http"));
  if (isRawIpLiteral(u.hostname)) return { url: wsUrl, options: {} };
  const scheme = wsUrl.startsWith("wss") ? "wss" : "ws";
  const dialUrl = `${scheme}://${ip}${u.port ? `:${u.port}` : ""}${u.pathname}${u.search}`;
  const options: PinnedWsDial["options"] = { headers: { host: u.host } };
  if (scheme === "wss") options.servername = u.hostname;
  return { url: dialUrl, options };
}
