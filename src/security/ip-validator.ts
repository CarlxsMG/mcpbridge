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

function buildIpv4Range(cidr: string): Ipv4Range {
  const [addr, prefixStr] = cidr.split("/");
  const prefixLen = parseInt(prefixStr, 10);
  const base = ipv4ToUint32(addr) as number;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { base: base & mask, mask };
}

const BLOCKED_IPV4_RANGES: Ipv4Range[] = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "0.0.0.0/8",
].map(buildIpv4Range);

function isBlockedIpv4(ip: string): boolean {
  const numeric = ipv4ToUint32(ip);
  if (numeric === null) return false;
  return BLOCKED_IPV4_RANGES.some(range => (numeric & range.mask) === range.base);
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
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
