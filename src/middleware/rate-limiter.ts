import type { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number[];
}

const buckets = new Map<string, Bucket>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    bucket.tokens = bucket.tokens.filter(t => now - t < 60_000);
    if (bucket.tokens.length === 0) buckets.delete(key);
  }
}, 300_000);

function checkLimit(key: string, maxPerMinute: number, res: Response): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: [] };
    buckets.set(key, bucket);
  }

  // Remove tokens older than 1 minute (sliding window)
  bucket.tokens = bucket.tokens.filter(t => now - t < 60_000);

  if (bucket.tokens.length >= maxPerMinute) {
    const oldestInWindow = bucket.tokens[0];
    const retryAfter = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many requests", retry_after: retryAfter }
    });
    return false;
  }

  bucket.tokens.push(now);
  return true;
}

export function rateLimitRegister(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `register:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    if (checkLimit(key, maxPerMinute, res)) next();
  };
}

export function rateLimitMcp(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = (req.headers["mcp-session-id"] as string) || req.query.sessionId as string || req.ip || "unknown";
    const key = `mcp:${sessionId}`;
    if (checkLimit(key, maxPerMinute, res)) next();
  };
}

export function rateLimitGlobal(maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = "global";
    if (checkLimit(key, maxPerMinute, res)) next();
  };
}
