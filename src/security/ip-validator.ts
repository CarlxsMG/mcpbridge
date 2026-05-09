/** Centralised SSRF-defence IP validator. */

import ipaddr from "ipaddr.js";

// ---------------------------------------------------------------------------
// IPv4 CIDR block list — all entries include a human-readable label.
// ---------------------------------------------------------------------------

/** Named list of blocked IPv4 CIDRs. No magic strings elsewhere in this file. */
export const BLOCKED_IPV4_CIDRS: readonly [string, string][] = [
  ["127.0.0.0/8",    "loopback"],
  ["10.0.0.0/8",     "RFC-1918 class-A private"],
  ["172.16.0.0/12",  "RFC-1918 class-B private"],
  ["192.168.0.0/16", "RFC-1918 class-C private"],
  ["169.254.0.0/16", "link-local"],
  ["0.0.0.0/8",      "unspecified / this-network"],
  ["100.64.0.0/10",  "CGNAT (RFC-6598)"],
  ["192.0.0.0/24",   "IETF protocol assignments (RFC-6890)"],
  ["192.0.2.0/24",   "TEST-NET-1 (RFC-5737)"],
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Pre-parse CIDR ranges once at module load for IPv4 matching.
const BLOCKED_IPV4_PARSED: Array<[ipaddr.IPv4, number]> = BLOCKED_IPV4_CIDRS.map(
  ([cidr]) => ipaddr.IPv4.parseCIDR(cidr)
);

function isBlockedIpv4(ip: string): boolean {
  let parsed: ipaddr.IPv4;
  try {
    parsed = ipaddr.IPv4.parse(ip);
  } catch {
    return false;
  }
  return BLOCKED_IPV4_PARSED.some(range => parsed.match(range));
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
    "reserved",  // covers 2001:db8::/32 (documentation), 100::/64 (discard), and others
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

  // 6to4 (2002::/16) — bits 16-47 (groups 1 and 2, i.e. parts[1]) encode an IPv4.
  // parts[1] = 16-bit group carrying the high 16 bits of embedded IPv4.
  // parts[2] = 16-bit group carrying the low 16 bits of embedded IPv4.
  // Wait: 6to4 is 2002:<v4hi16>:<v4lo16>::/48 — parts[1] = high word, parts[2] = low word.
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

export async function validateBackendUrl(
  url: string,
  allowPrivateIps: boolean,
  allowedHosts: string[]
): Promise<{ valid: boolean; reason?: string; resolvedIp?: string }> {
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
  const isRawIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const isRawIpv6 = hostname.startsWith("[") || hostname.includes(":");

  if (isRawIpv4 || isRawIpv6) {
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

  const v4Records: { address: string }[] =
    v4Result.status === "fulfilled" ? v4Result.value : [];
  const v6Records: { address: string }[] =
    v6Result.status === "fulfilled" ? v6Result.value : [];

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
