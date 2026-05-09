import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern === "*") return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  // Support wildcard port: "http://localhost:*"
  if (pattern.endsWith(":*")) {
    const patternBase = pattern.slice(0, -2); // "http://localhost"
    let parsedPattern: URL;
    try {
      parsedPattern = new URL(patternBase);
    } catch {
      return false;
    }
    const protocolMatch = parsedOrigin.protocol === parsedPattern.protocol;
    const hostMatch = parsedOrigin.hostname.toLowerCase() === parsedPattern.hostname.toLowerCase();
    // port must be empty string (default for scheme) or a non-empty numeric string
    const portVal = parsedOrigin.port;
    const portMatch = portVal === "" || /^\d+$/.test(portVal);
    return protocolMatch && hostMatch && portMatch;
  }

  // Exact match: compare parsed components
  let parsedPattern: URL;
  try {
    parsedPattern = new URL(pattern);
  } catch {
    return false;
  }
  return (
    parsedOrigin.protocol === parsedPattern.protocol &&
    parsedOrigin.hostname.toLowerCase() === parsedPattern.hostname.toLowerCase() &&
    parsedOrigin.port === parsedPattern.port
  );
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
