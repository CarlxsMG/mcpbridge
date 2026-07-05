/**
 * Shared low-level Origin-allowlist matching primitive used by both
 * `middleware/cors.ts` (matched against `config.corsOrigins`) and
 * `middleware/origin-validator.ts` (matched against `config.allowedOrigins`).
 *
 * These two middlewares intentionally keep separate config sources and
 * separate rule sets — only origin-validator's allowlist supports a ":*"
 * port-wildcard suffix (e.g. "http://localhost:*"). Unifying those config
 * sources or rule sets is a security-policy decision, not a refactor, and is
 * deliberately NOT done here. This module only removes the duplicated
 * "parse an Origin header and compare it against one allowlist entry"
 * arithmetic that both files independently implemented; each call site keeps
 * driving its own config source and requests its own rule set via the
 * `supportsPortWildcard` flag.
 */

/** Structural parts of a parsed Origin/entry URL used for comparison. */
interface OriginParts {
  /** `URL#protocol`, including the trailing colon (e.g. `"https:"`). */
  protocol: string;
  /** Lowercased `URL#hostname`. */
  hostname: string;
  /** `URL#port` — `""` when omitted/default for the scheme, else numeric. */
  port: string;
}

function parseOriginParts(raw: string): OriginParts | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return { protocol: url.protocol, hostname: url.hostname.toLowerCase(), port: url.port };
}

/**
 * Compares a request `Origin` header value against a single allowlist entry.
 *
 * - `entry === "*"` matches unconditionally.
 * - When `supportsPortWildcard` is true, an entry ending in `":*"` (e.g.
 *   `"http://localhost:*"`) matches on protocol + hostname alone, ignoring
 *   port — mirrors origin-validator.ts's pre-existing port-wildcard rule.
 *   `URL#port` is always either `""` or a numeric string, so once `origin`
 *   parses successfully there is nothing further to validate about its port.
 * - Otherwise `entry` must itself parse as a full origin URL, and
 *   protocol + hostname + port are compared exactly.
 *
 * Returns `false` (never throws) if either side fails to parse as a URL.
 */
export function matchesOriginEntry(origin: string, entry: string, options: { supportsPortWildcard: boolean }): boolean {
  if (entry === "*") return true;

  if (options.supportsPortWildcard && entry.endsWith(":*")) {
    const originParts = parseOriginParts(origin);
    if (!originParts) return false;
    const entryParts = parseOriginParts(entry.slice(0, -2));
    if (!entryParts) return false;
    return originParts.protocol === entryParts.protocol && originParts.hostname === entryParts.hostname;
  }

  const originParts = parseOriginParts(origin);
  if (!originParts) return false;
  const entryParts = parseOriginParts(entry);
  if (!entryParts) return false;
  return (
    originParts.protocol === entryParts.protocol &&
    originParts.hostname === entryParts.hostname &&
    originParts.port === entryParts.port
  );
}
