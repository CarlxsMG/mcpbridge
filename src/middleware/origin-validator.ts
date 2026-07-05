import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { forbidden } from "../routes/http-errors.js";
import { matchesOriginEntry } from "../lib/origin-match.js";

/**
 * Pure predicate behind originValidator — usable from a raw upgrade request
 * (WS-proxy) that has no Express `Response` to write a 403 onto directly.
 * WS handshakes bypass browser CORS/preflight, so Origin must be checked
 * manually there too, against this same allowlist.
 */
export function isOriginAllowed(origin: string | undefined, secFetchSite: string | undefined): boolean {
  if (!origin) return !secFetchSite; // server-to-server (no Origin) allowed unless it's clearly a browser request
  return config.allowedOrigins.some((pattern) => matchesOriginEntry(origin, pattern, { supportsPortWildcard: true }));
}

export function originValidator(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;
  const secFetchSite = req.headers["sec-fetch-site"] as string | undefined;

  if (isOriginAllowed(origin, secFetchSite)) {
    next();
    return;
  }

  if (!origin) {
    forbidden(res, "ORIGIN_NOT_ALLOWED", "Origin header required for browser requests");
    return;
  }
  forbidden(res, "ORIGIN_NOT_ALLOWED", "Origin not allowed");
}
