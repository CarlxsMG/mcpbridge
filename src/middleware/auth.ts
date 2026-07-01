import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { safeCompare } from "../security/compare.js";
import { validateSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, parseCookies } from "../security/cookies.js";
import type { AdminRole } from "../security/user-store.js";

export interface AuthContext {
  method: "bearer" | "session";
  userId?: number;
  username?: string;
  role?: AdminRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

/**
 * Admin auth accepts EITHER a Bearer token (existing programmatic/CI callers —
 * evaluated first and completely unchanged, so their behaviour can never
 * shift even at the margin) OR a session cookie + CSRF header (the admin UI).
 * Mutating requests authenticated via session additionally require a valid
 * `X-CSRF-Token` — Bearer calls are exempt since they're never cookie-based
 * and therefore not CSRF-vulnerable.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authDisabled) { next(); return; }

  const bearerToken = extractBearerToken(req);
  if (bearerToken !== null) {
    if (!config.adminApiKeys.some(key => safeCompare(key, bearerToken))) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid API key" } });
      return;
    }
    req.authContext = { method: "bearer" };
    next();
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE_NAME];
  if (!sessionToken) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header or session cookie" } });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Session expired or invalid" } });
    return;
  }

  if (!SAFE_METHODS.has(req.method)) {
    const csrfHeader = req.headers["x-csrf-token"];
    const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!csrfToken || !safeCompare(csrfToken, session.csrfToken)) {
      res.status(403).json({ error: { code: "CSRF_VALIDATION_FAILED", message: "Missing or invalid X-CSRF-Token header" } });
      return;
    }
  }

  req.authContext = { method: "session", userId: session.userId, username: session.username, role: session.role };
  next();
}

export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authDisabled) { next(); return; }
  // If no MCP API keys configured, allow all (backward compat)
  if (config.mcpApiKeys.length === 0) { next(); return; }
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } });
    return;
  }
  if (!config.mcpApiKeys.some(key => safeCompare(key, token))) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid API key" } });
    return;
  }
  next();
}
