import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  rateLimitHits,
  rateLimitEvictions,
} from "../observability/metrics.js";

interface Bucket {
  tokens: number[];
}

/** LRU-bounded Map keyed by rate-limit key, value is the sliding-window bucket. */
const globalBuckets = new Map<string, Bucket>();
const mcpBuckets = new Map<string, Bucket>();
const registerBuckets = new Map<string, Bucket>();

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

function checkLimit(
  map: Map<string, Bucket>,
  maxSize: number,
  key: string,
  maxPerMinute: number,
  tier: string,
  res: Response,
): boolean {
  const now = Date.now();
  let bucket = lruGet(map, key);
  if (!bucket) {
    bucket = { tokens: [] };
    lruSet(map, key, bucket, maxSize, tier);
  }

  // Prune expired tokens from the sliding window.
  bucket.tokens = bucket.tokens.filter(t => now - t < WINDOW_MS);

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
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many requests", retry_after: retryAfter },
    });
    return false;
  }

  bucket.tokens.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Test-only internals — NOT part of the public API surface.
// Only import from __tests__; never from production code.
// ---------------------------------------------------------------------------

/**
 * Returns current bucket map sizes per tier for Prometheus gauge snapshots.
 */
export function getRateLimitBucketSizes(): Record<"global" | "mcp" | "register", number> {
  return {
    global: globalBuckets.size,
    mcp: mcpBuckets.size,
    register: registerBuckets.size,
  };
}

/** @internal */
export const _internalsForTesting = {
  /** Direct access to the per-endpoint bucket maps for LRU eviction assertions. */
  globalBuckets,
  mcpBuckets,
  registerBuckets,
  lruGet,
  lruSet,
  checkLimit,
};

/** Evict empty buckets from a map to bound memory between LRU evictions. */
function evictEmpty(map: Map<string, Bucket>, tier: string): void {
  const now = Date.now();
  for (const [key, bucket] of map) {
    bucket.tokens = bucket.tokens.filter(t => now - t < WINDOW_MS);
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
  }, config.rateLimitCleanupIntervalMs);

  return () => clearInterval(handle);
}

export function rateLimitRegister(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `register:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
    if (checkLimit(registerBuckets, config.rateLimitMaxBucketsRegister, key, maxPerMinute, "register", res)) {
      next();
    }
  };
}

export function rateLimitMcp(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId =
      (req.headers["mcp-session-id"] as string) ||
      (req.query.sessionId as string) ||
      req.ip ||
      "unknown";
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
