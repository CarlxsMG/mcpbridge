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
  corsOrigins: process.env.CORS_ORIGINS?.split(",").map(o => o.trim()).filter(Boolean) ?? [],
  authDisabled: process.env.AUTH_DISABLED === "true",
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
};
