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

/**
 * Pure predicate behind originValidator — usable from a raw upgrade request
 * (WS-proxy) that has no Express `Response` to write a 403 onto directly.
 * WS handshakes bypass browser CORS/preflight, so Origin must be checked
 * manually there too, against this same allowlist.
 */
export function isOriginAllowed(origin: string | undefined, secFetchSite: string | undefined): boolean {
  if (!origin) return !secFetchSite; // server-to-server (no Origin) allowed unless it's clearly a browser request
  return config.allowedOrigins.some(pattern => matchOrigin(origin, pattern));
}

export function originValidator(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;
  const secFetchSite = req.headers["sec-fetch-site"] as string | undefined;

  if (isOriginAllowed(origin, secFetchSite)) {
    next();
    return;
  }

  if (!origin) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin header required for browser requests" } });
    return;
  }
  res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" } });
}
