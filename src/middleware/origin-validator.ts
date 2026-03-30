import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // Support wildcard port: "http://localhost:*"
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // "http://localhost:"
    return origin.startsWith(prefix);
  }
  return origin === pattern;
}

export function originValidator(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;
  const secFetchSite = req.headers["sec-fetch-site"] as string | undefined;

  // No Origin header
  if (!origin) {
    // If Sec-Fetch-Site is present, this is a browser request — reject
    if (secFetchSite) {
      res.status(403).json({ error: "Origin header required for browser requests" });
      return;
    }
    // Server-to-server: allow
    next();
    return;
  }

  // Check against allowed origins
  const allowed = config.allowedOrigins;
  if (allowed.some(pattern => matchOrigin(origin, pattern))) {
    next();
    return;
  }

  res.status(403).json({ error: "Origin not allowed" });
}
