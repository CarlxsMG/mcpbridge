/** Centralised SSRF-defence IP validator. */

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
// IPv6 address literals that are always blocked.
// ---------------------------------------------------------------------------

/** Blocked IPv6 address literals (normalised to lowercase). */
const BLOCKED_IPV6_LITERALS = new Set<string>(["::1", "::", "0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

interface Ipv4Range {
  base: number;
  mask: number;
}

/**
 * Build a pre-computed CIDR range object from a "a.b.c.d/n" string.
 * @param cidr - CIDR notation string, e.g. "10.0.0.0/8"
 */
function buildIpv4Range(cidr: string): Ipv4Range {
  const [addr, prefixStr] = cidr.split("/");
  const prefixLen = parseInt(prefixStr, 10);
  const base = ipv4ToUint32(addr) as number;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { base: base & mask, mask };
}

/**
 * Check whether a numeric IPv4 address falls inside a pre-built CIDR range.
 * @param numeric - result of `ipv4ToUint32`
 * @param range   - pre-built range from `buildIpv4Range`
 */
function isInCidr(numeric: number, range: Ipv4Range): boolean {
  return (numeric & range.mask) === range.base;
}

const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = BLOCKED_IPV4_CIDRS.map(([cidr]) => buildIpv4Range(cidr));

function isBlockedIpv4(ip: string): boolean {
  const numeric = ipv4ToUint32(ip);
  if (numeric === null) return false;
  return BLOCKED_IPV4_RANGES.some(range => isInCidr(numeric, range));
}

// Matches the dotted-decimal form of an IPv4-mapped IPv6 address: ::ffff:1.2.3.4
const IPV4_MAPPED_DOTTED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

// Matches the hex-word form of an IPv4-mapped IPv6 address: ::ffff:7f00:1
const IPV4_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * Attempt to extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Returns null if `ip` is not an IPv4-mapped address.
 */
function extractMappedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();

  // Dotted-decimal form: ::ffff:127.0.0.1
  const dottedMatch = IPV4_MAPPED_DOTTED_RE.exec(lower);
  if (dottedMatch) {
    return dottedMatch[1];
  }

  // Hex-word form: ::ffff:7f00:0001  →  127.0.0.1
  const hexMatch = IPV4_MAPPED_HEX_RE.exec(lower);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Blocked literals (includes :: and ::1)
  if (BLOCKED_IPV6_LITERALS.has(lower)) return true;

  // IPv4-mapped IPv6 addresses — extract and test the embedded IPv4
  const mapped = extractMappedIpv4(lower);
  if (mapped !== null) {
    return isBlockedIpv4(mapped);
  }

  // Unique local (fc00::/7)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  // Link-local (fe80::/10)
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) return true;

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

  // Always resolve DNS to pin the IP, unless it is already a raw IP address
  const isRawIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const isRawIpv6 = hostname.startsWith("[") || hostname.includes(":");

  if (isRawIpv4 || isRawIpv6) {
    // Already an IP literal — use it directly as the pinned address
    const rawIp = isRawIpv6 ? hostname.replace(/^\[|\]$/g, "") : hostname;
    if (!allowPrivateIps && isPrivateIp(rawIp)) {
      return { valid: false, reason: `IP is in a blocked private range: ${rawIp}` };
    }
    return { valid: true, resolvedIp: rawIp };
  }

  let results: { address: string }[];
  try {
    results = await Bun.dns.lookup(hostname, { family: 4 });
  } catch {
    return { valid: false, reason: `DNS resolution failed for: ${hostname}` };
  }

  if (results.length === 0) {
    return { valid: false, reason: `DNS resolution returned no records for: ${hostname}` };
  }

  for (const record of results) {
    if (!allowPrivateIps && isPrivateIp(record.address)) {
      return { valid: false, reason: `Resolved IP is in a blocked private range: ${record.address}` };
    }
  }

  // Pin to the first resolved address
  return { valid: true, resolvedIp: results[0].address };
}
