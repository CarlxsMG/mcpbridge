import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { safeCompare } from "../security/compare.js";
import { validateSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, parseCookies } from "../security/cookies.js";
import type { AdminRole } from "../security/user-store.js";
import { findUserById } from "../security/user-store.js";
import { resolveMcpKeyByToken, touchMcpKeyLastUsed, hasAnyMcpKeys } from "../security/mcp-key-store.js";
import { verifyJwt, isJwtConfigured } from "../security/jwt.js";

export interface AuthContext {
  method: "bearer" | "session";
  userId?: number;
  username?: string;
  role?: AdminRole;
  /** Session user's team id (null = super-admin). Undefined for bearer callers (always super-admin). */
  teamId?: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authContext?: AuthContext;
      /** Set by mcpAuth when the caller authenticated with a DB-managed MCP key. */
      mcpKeyId?: number;
      /** Set by mcpAuth when the caller authenticated with a verified inbound JWT (its `sub`). */
      jwtSubject?: string;
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

  // Resolve the caller's team for tenancy scoping (null = super-admin).
  const teamId = findUserById(session.userId)?.teamId ?? null;
  req.authContext = { method: "session", userId: session.userId, username: session.username, role: session.role, teamId };
  next();
}

/**
 * MCP auth accepts EITHER a legacy env `MCP_API_KEYS` entry (unchanged,
 * constant-time compared) OR a DB-managed key minted via the admin API
 * (enabled, not revoked, not expired). Backward-compat "open mode" is
 * preserved only when NO auth material exists at all — neither env keys nor
 * any managed keys — so simply minting a managed key transparently locks
 * down the MCP surface.
 */
export async function mcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (config.authDisabled) { next(); return; }

  const envConfigured = config.mcpApiKeys.length > 0;
  const token = extractBearerToken(req);

  if (token) {
    if (envConfigured && config.mcpApiKeys.some(key => safeCompare(key, token))) { next(); return; }
    const managed = resolveMcpKeyByToken(token);
    if (managed) {
      req.mcpKeyId = managed.id;
      touchMcpKeyLastUsed(managed.id);
      next();
      return;
    }
    // Optional inbound JWT (OAuth2/OIDC access token) — accepted when configured
    // and its signature + claims verify. An ADDITIONAL credential, never a bypass.
    if (isJwtConfigured()) {
      const verdict = await verifyJwt(token);
      if (verdict.valid) {
        req.jwtSubject = typeof verdict.claims.sub === "string" ? verdict.claims.sub : undefined;
        next();
        return;
      }
    }
  }

  // Preserve the historical "no auth material => allow all" behaviour, but only
  // when there is genuinely nothing to check against — configuring JWT (like
  // minting a managed key) locks the surface down too.
  if (!envConfigured && !hasAnyMcpKeys() && !isJwtConfigured()) { next(); return; }

  if (!token) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing Authorization header" } });
    return;
  }
  res.status(403).json({ error: { code: "FORBIDDEN", message: "Invalid API key" } });
}
