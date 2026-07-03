import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { log } from "../logger.js";
import { rateLimitHits, rateLimitEvictions } from "../observability/metrics.js";

interface Bucket {
  tokens: number[];
}

/**
 * Normalise a raw IP string for consistent rate-limit bucket keying.
 * - Returns 'unknown' for falsy input.
 * - Strips IPv4-mapped IPv6 prefix (::ffff:) → bare IPv4.
 * - Lowercases.
 * - Strips zone IDs (everything after '%').
 */
function normalizeIp(raw: string | undefined): string {
  if (!raw) return "unknown";
  let ip = raw.toLowerCase();
  // Strip zone ID (e.g. fe80::1%eth0 → fe80::1)
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip || "unknown";
}

/** LRU-bounded Map keyed by rate-limit key, value is the sliding-window bucket. */
const globalBuckets = new Map<string, Bucket>();
const mcpBuckets = new Map<string, Bucket>();
const registerBuckets = new Map<string, Bucket>();
/** Per-tool admin guard rate limits — only populated for tools that have one configured. */
const toolBuckets = new Map<string, Bucket>();
const loginBuckets = new Map<string, Bucket>();
const installLinkBuckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;

/** Anonymise a rate-limit key for safe logging (first 12 hex chars of SHA-256). */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Promote key to the end of the Map (LRU recency) and return the bucket.
 * If the key doesn't exist, returns undefined.
 */
function lruGet(map: Map<string, Bucket>, key: string): Bucket | undefined {
  const bucket = map.get(key);
  if (bucket === undefined) return undefined;
  // Re-insert to mark as most-recently-used.
  map.delete(key);
  map.set(key, bucket);
  return bucket;
}

/**
 * Insert a new bucket, evicting the LRU entry when the map is at capacity.
 * Logs an eviction warning sampled at 1/100.
 */
function lruSet(map: Map<string, Bucket>, key: string, bucket: Bucket, maxSize: number, tier = "unknown"): void {
  if (map.size >= maxSize) {
    const evictKey = map.keys().next().value as string;
    map.delete(evictKey);
    rateLimitEvictions.inc({ tier, cause: "lru" });
    if (Math.random() < 0.01) {
      log("warn", "Rate-limiter LRU eviction", { evicted_key_hash: hashKey(evictKey) });
    }
  }
  map.set(key, bucket);
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  currentCount: number;
}

/**
 * Pure sliding-window check — no Express `Request`/`Response` dependency, so
 * it's usable both from HTTP middleware and from non-HTTP call sites like
 * `proxyToolCall` (which only has a tool name and args, not a `res` to write
 * a 429 onto directly).
 */
export function checkRateLimit(
  map: Map<string, Bucket>,
  maxSize: number,
  key: string,
  maxPerMinute: number,
  tier: string,
): RateLimitResult {
  const now = Date.now();
  let bucket = lruGet(map, key);
  if (!bucket) {
    bucket = { tokens: [] };
    lruSet(map, key, bucket, maxSize, tier);
  }

  // Prune expired tokens from the sliding window.
  bucket.tokens = bucket.tokens.filter((t) => now - t < WINDOW_MS);

  if (bucket.tokens.length >= maxPerMinute) {
    const oldestInWindow = bucket.tokens[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    rateLimitHits.inc({ tier });
    log("warn", "Rate limit triggered", {
      tier,
      key_hash: hashKey(key),
      current: bucket.tokens.length,
      limit: maxPerMinute,
      retry_after: retryAfter,
    });
    return { allowed: false, retryAfterSeconds: retryAfter, currentCount: bucket.tokens.length };
  }

  bucket.tokens.push(now);
  return { allowed: true, currentCount: bucket.tokens.length };
}

/** Express-facing wrapper — writes the 429 response itself, same behaviour as before the checkRateLimit extraction. */
function checkLimit(
  map: Map<string, Bucket>,
  maxSize: number,
  key: string,
  maxPerMinute: number,
  tier: string,
  res: Response,
): boolean {
  const result = checkRateLimit(map, maxSize, key, maxPerMinute, tier);
  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many requests", retry_after: result.retryAfterSeconds },
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test-only internals — NOT part of the public API surface.
// Only import from __tests__; never from production code.
// ---------------------------------------------------------------------------

/**
 * Returns current bucket map sizes per tier for Prometheus gauge snapshots.
 */
export function getRateLimitBucketSizes(): Record<
  "global" | "mcp" | "register" | "tool" | "login" | "install_link",
  number
> {
  return {
    global: globalBuckets.size,
    mcp: mcpBuckets.size,
    register: registerBuckets.size,
    tool: toolBuckets.size,
    login: loginBuckets.size,
    install_link: installLinkBuckets.size,
  };
}

/** @internal */
export const _internalsForTesting = {
  /** Direct access to the per-endpoint bucket maps for LRU eviction assertions. */
  globalBuckets,
  mcpBuckets,
  registerBuckets,
  toolBuckets,
  loginBuckets,
  installLinkBuckets,
  lruGet,
  lruSet,
  checkLimit,
};

/** Evict empty buckets from a map to bound memory between LRU evictions. */
function evictEmpty(map: Map<string, Bucket>, tier: string): void {
  const now = Date.now();
  for (const [key, bucket] of map) {
    bucket.tokens = bucket.tokens.filter((t) => now - t < WINDOW_MS);
    if (bucket.tokens.length === 0) {
      map.delete(key);
      rateLimitEvictions.inc({ tier, cause: "empty" });
    }
  }
}

/**
 * Starts the background cleanup loop for all rate-limiter bucket maps.
 * Returns a stop function; call it during graceful shutdown.
 */
export function startRateLimiterCleanup(): () => void {
  const handle = setInterval(() => {
    evictEmpty(globalBuckets, "global");
    evictEmpty(mcpBuckets, "mcp");
    evictEmpty(registerBuckets, "register");
    evictEmpty(toolBuckets, "tool");
    evictEmpty(loginBuckets, "login");
    evictEmpty(installLinkBuckets, "install_link");
  }, config.rateLimitCleanupIntervalMs);

  return () => clearInterval(handle);
}

export function rateLimitRegister(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `register:${normalizeIp(req.ip ?? req.socket?.remoteAddress)}`;
    if (checkLimit(registerBuckets, config.rateLimitMaxBucketsRegister, key, maxPerMinute, "register", res)) {
      next();
    }
  };
}

/** Aggressive per-IP rate limit for POST /admin-api/auth/login, to resist credential stuffing. */
export function rateLimitLogin(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `login:${normalizeIp(req.ip ?? req.socket?.remoteAddress)}`;
    if (checkLimit(loginBuckets, config.rateLimitMaxBucketsLogin, key, maxPerMinute, "login", res)) {
      next();
    }
  };
}

/**
 * Per-IP rate limit for the public, unauthenticated GET /install/:token route.
 * Defense in depth against token-enumeration abuse — see config.rateLimitInstallLink.
 */
export function rateLimitInstallLink(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `install_link:${normalizeIp(req.ip ?? req.socket?.remoteAddress)}`;
    if (checkLimit(installLinkBuckets, config.rateLimitMaxBucketsInstallLink, key, maxPerMinute, "install_link", res)) {
      next();
    }
  };
}

export function rateLimitMcp(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId =
      (req.headers["mcp-session-id"] as string) ||
      (req.query.sessionId as string) ||
      normalizeIp(req.ip ?? req.socket?.remoteAddress);
    const key = `mcp:${sessionId}`;
    if (checkLimit(mcpBuckets, config.rateLimitMaxBucketsMcp, key, maxPerMinute, "mcp", res)) {
      next();
    }
  };
}

export function rateLimitGlobal(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = "global";
    if (checkLimit(globalBuckets, config.rateLimitMaxBucketsGlobal, key, maxPerMinute, "global", res)) {
      next();
    }
  };
}

/**
 * Per-tool admin guard rate limit — called directly from `proxyToolCall`
 * (not mounted as Express middleware, since a single `/mcp` route can't see
 * which tool a JSON-RPC call targets until after the body is parsed).
 * `toolKey` is the composite `clientName__toolName` key.
 */
export function checkToolRateLimit(toolKey: string, maxPerMinute: number): RateLimitResult {
  return checkRateLimit(toolBuckets, config.rateLimitMaxBucketsTool, toolKey, maxPerMinute, "tool");
}
