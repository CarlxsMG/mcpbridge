/**
 * Parses the TRUST_PROXY environment variable into the value accepted by
 * Express `app.set("trust proxy", ...)`.
 *
 * Modes:
 *   - "true"  → boolean true  (trust all proxies — use only behind a single known proxy)
 *   - numeric → number of trusted hops (e.g. "1" trusts the first hop only)
 *   - CSV IPs → Express supports a comma-separated string of trusted IP ranges
 *   - absent  → false (no proxy trust)
 */
function parseTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY;
  if (!raw) return false;
  if (raw === "true") return true;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  // CSV of IPs/CIDRs — pass through as-is for Express
  return raw;
}

/**
 * Normalises a single CORS origin string to `scheme://host` (with port if
 * non-standard).  Returns `null` when the entry is invalid so callers can
 * reject it cleanly.
 *
 * Rules:
 *   - scheme must be `http` or `https`
 *   - host must be non-empty
 *   - no path, query, or fragment components are allowed
 *   - the returned string never has a trailing slash
 */
function normaliseOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") return null;
  if (!url.hostname) return null;
  // Reject any path (beyond "/"), query, or fragment
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search) return null;
  if (url.hash) return null;
  // Rebuild canonical form: scheme + "://" + lowercase-host + optional port
  const host = url.hostname.toLowerCase();
  const port = url.port; // empty string when it matches the default for the scheme
  return port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}

/**
 * Parses and validates the CORS_ORIGINS environment variable value.
 *
 * Accepts a comma-separated list of origins.  Each entry must be a valid
 * `http` or `https` URL with no path/query/fragment.  The special value `"*"`
 * is allowed only when auth is disabled OR when
 * `ALLOW_UNSAFE_CORS_WILDCARD=true` is explicitly set.
 *
 * @param raw - Raw value of `process.env.CORS_ORIGINS`.
 * @param authDisabled - Whether AUTH_DISABLED is currently true.
 * @returns Normalised array of origin strings, or `["*"]` for wildcard mode.
 * @throws {Error} When the input is invalid or wildcard is used unsafely.
 */
export function parseCorsOrigins(
  raw: string | undefined,
  authDisabled: boolean,
): string[] {
  if (!raw || raw.trim() === "") return [];

  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);

  if (entries.includes("*")) {
    const allowUnsafe = process.env.ALLOW_UNSAFE_CORS_WILDCARD === "true";
    if (!authDisabled && !allowUnsafe) {
      throw new Error(
        "CORS wildcard '*' is forbidden when auth is enabled. " +
          "Set ALLOW_UNSAFE_CORS_WILDCARD=true to override (NOT recommended in production).",
      );
    }
    return ["*"];
  }

  const normalised: string[] = [];
  for (const entry of entries) {
    const norm = normaliseOrigin(entry);
    if (norm === null) {
      throw new Error(
        `Invalid CORS origin: "${entry}". ` +
          "Each entry must be a valid http:// or https:// URL with no path, query, or fragment.",
      );
    }
    normalised.push(norm);
  }
  return normalised;
}

const authDisabled = process.env.AUTH_DISABLED === "true";
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS, authDisabled);

export const config = {
  port: Number(process.env.PORT) || 3000,
  toolCallTimeoutMs: Number(process.env.TOOL_CALL_TIMEOUT_MS) || 30_000,
  healthCheckTimeoutMs: Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 5_000,
  healthCheckIntervalMs: Number(process.env.HEALTH_CHECK_INTERVAL_MS) || 30_000,
  /** Maximum number of concurrent health checks per batch. */
  healthCheckMaxConcurrent: Number(process.env.HEALTH_CHECK_MAX_CONCURRENT) || 20,
  openapiDiscoveryTimeoutMs: Number(process.env.OPENAPI_DISCOVERY_TIMEOUT_MS) || 10_000,
  sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 1_800_000,
  maxSessions: Number(process.env.MAX_SESSIONS) || 100,
  allowPrivateIps: process.env.ALLOW_PRIVATE_IPS === "true",
  allowedHosts: process.env.ALLOWED_HOSTS?.split(",").map(h => h.trim()).filter(Boolean) ?? [],
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()).filter(Boolean) ?? ["http://localhost:*"],
  corsOrigins,
  authDisabled,
  adminApiKeys: process.env.ADMIN_API_KEYS?.split(",").map(k => k.trim()).filter(Boolean) ?? [],
  mcpApiKeys: process.env.MCP_API_KEYS?.split(",").map(k => k.trim()).filter(Boolean) ?? [],
  rateLimitRegister: Number(process.env.RATE_LIMIT_REGISTER) || 10,
  rateLimitMcp: Number(process.env.RATE_LIMIT_MCP) || 100,
  rateLimitGlobal: Number(process.env.RATE_LIMIT_GLOBAL) || 1000,
  logFormat: (process.env.LOG_FORMAT as "json" | "text") || "json",
  /** Consecutive health-check failures before a client is auto-evicted. */
  maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES) || 3,
  trustProxy: parseTrustProxy(),
  /** Maximum upstream response body size in bytes. Responses exceeding this are rejected. */
  maxResponseBytes: Number(process.env.MAX_RESPONSE_BYTES) || 10_485_760,
  /** Maximum value honoured from a Retry-After header, in milliseconds. */
  retryAfterMaxMs: Number(process.env.RETRY_AFTER_MAX_MS) || 30_000,
  /** Maximum number of retry attempts for idempotent requests (total attempts = retryMaxAttempts + 1). */
  retryMaxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS) || 2,
  /** Base delay in milliseconds for exponential backoff between retries. */
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS) || 500,
  /** Sliding-window duration for circuit-breaker failure counting (ms). */
  circuitBreakerWindowMs: Number(process.env.CIRCUIT_BREAKER_WINDOW_MS) || 60_000,
  /** Number of failures within circuitBreakerWindowMs that trips the breaker. */
  circuitBreakerFailureThreshold: Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD) || 3,
  /** Milliseconds before an open circuit breaker transitions to half-open for a probe attempt. */
  circuitBreakerResetTimeoutMs: Number(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS) || 30_000,
  /** Timeout applied to the single probe request sent in half-open state (ms). */
  circuitBreakerHalfOpenTimeoutMs: Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS) || 5_000,
  /** Interval in milliseconds between rate-limiter bucket cleanup passes. */
  rateLimitCleanupIntervalMs: Number(process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS) || 300_000,
  /** Maximum number of LRU buckets in the global rate-limiter map. */
  rateLimitMaxBucketsGlobal: Number(process.env.RATE_LIMIT_MAX_BUCKETS_GLOBAL) || 50_000,
  /** Maximum number of LRU buckets in the MCP session rate-limiter map. */
  rateLimitMaxBucketsMcp: Number(process.env.RATE_LIMIT_MAX_BUCKETS_MCP) || 100_000,
  /** Maximum number of LRU buckets in the register rate-limiter map. */
  rateLimitMaxBucketsRegister: Number(process.env.RATE_LIMIT_MAX_BUCKETS_REGISTER) || 10_000,
  /** Milliseconds to wait before force-exiting during graceful shutdown. */
  shutdownForceExitMs: Number(process.env.SHUTDOWN_FORCE_EXIT_MS) || 10_000,

  // ─── CORS constants ────────────────────────────────────────────────────────
  /** HTTP methods advertised in Access-Control-Allow-Methods. */
  corsAllowedMethods: ["GET", "POST", "DELETE", "OPTIONS"] as readonly string[],
  /**
   * Headers advertised in Access-Control-Allow-Headers.
   * Matches all headers the application reads from inbound requests.
   */
  corsAllowedHeaders: [
    "Content-Type",
    "Authorization",
    "Mcp-Session-Id",
    "X-Request-Id",
  ] as readonly string[],
  /** Headers exposed to the browser via Access-Control-Expose-Headers. */
  corsExposedHeaders: ["Mcp-Session-Id", "X-Request-Id"] as readonly string[],
  /** Preflight cache duration in seconds (Access-Control-Max-Age). */
  corsMaxAgeSeconds: Number(process.env.CORS_MAX_AGE_SECONDS) || 600,
  /**
   * Whether to send Access-Control-Allow-Credentials: true.
   * Only honoured when the request origin is in the allowlist.
   * Never sent in wildcard mode.
   */
  corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS === "true",
};
