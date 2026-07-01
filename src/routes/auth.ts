import type { Request, Response, Express } from "express";
import { config } from "../config.js";
import { log } from "../logger.js";
import { adminAuth } from "../middleware/auth.js";
import { rateLimitLogin } from "../middleware/rate-limiter.js";
import { findUserByUsername, touchLastLogin, updatePassword } from "../security/user-store.js";
import {
  createSession,
  revokeSession,
  revokeAllSessionsForUser,
  listActiveSessionsForUser,
  revokeSessionById,
} from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, parseCookies } from "../security/cookies.js";

// A syntactically-valid argon2id hash with no corresponding real user, verified
// against on every login where the username doesn't exist — keeps failure
// latency indistinguishable from a real wrong-password attempt (no user-enumeration
// timing side-channel).
const DUMMY_HASH = "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function setSessionCookies(res: Response, token: string, csrfToken: string, expiresAt: number): void {
  const maxAge = Math.max(0, expiresAt - Date.now());
  const shared = { secure: config.sessionCookieSecure, sameSite: "lax" as const, path: "/", maxAge };
  res.cookie(SESSION_COOKIE_NAME, token, { ...shared, httpOnly: true });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, { ...shared, httpOnly: false });
}

function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}

export function authRoutes(app: Express): void {
  app.post("/admin-api/auth/login", rateLimitLogin(config.rateLimitLogin), async (req: Request, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? null;
    const body = req.body as Record<string, unknown> | null;
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "username and password are required", request_id: requestId },
      });
      return;
    }

    const user = findUserByUsername(username);
    const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
    const valid = await Bun.password.verify(password, hashToVerify).catch(() => false);

    if (!user || !user.isActive || !valid) {
      log("warn", "Admin login failed", { username, request_id: requestId });
      res.status(401).json({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid username or password", request_id: requestId },
      });
      return;
    }

    const session = createSession(user.id, req.socket?.remoteAddress, req.headers["user-agent"]);
    touchLastLogin(user.id);
    setSessionCookies(res, session.token, session.csrfToken, session.expiresAt);

    log("info", "Admin login succeeded", { username: user.username, request_id: requestId });
    res.status(200).json({
      user: { username: user.username, role: user.role },
      csrf_token: session.csrfToken,
    });
  });

  app.post("/admin-api/auth/logout", adminAuth, (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) revokeSession(token);
    clearSessionCookies(res);
    res.status(200).json({ status: "logged_out" });
  });

  app.get("/admin-api/auth/me", adminAuth, (req: Request, res: Response) => {
    const ctx = req.authContext;
    if (!ctx || ctx.method === "bearer") {
      res.status(200).json({ authenticated: true, auth_method: "bearer" });
      return;
    }
    res.status(200).json({
      authenticated: true,
      auth_method: "session",
      user: { username: ctx.username, role: ctx.role },
    });
  });

  app.patch("/admin-api/auth/me/password", adminAuth, async (req: Request, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? null;
    const ctx = req.authContext;
    if (!ctx || ctx.method !== "session" || !ctx.username) {
      res.status(403).json({
        error: { code: "FORBIDDEN", message: "Password change requires a session-authenticated user", request_id: requestId },
      });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    const currentPassword = typeof body?.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body?.new_password === "string" ? body.new_password : "";

    if (!currentPassword || !newPassword || newPassword.length < 12) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "current_password and new_password (min 12 chars) are required", request_id: requestId },
      });
      return;
    }

    const user = findUserByUsername(ctx.username);
    const valid = user ? await Bun.password.verify(currentPassword, user.passwordHash).catch(() => false) : false;
    if (!user || !valid) {
      res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Current password is incorrect", request_id: requestId } });
      return;
    }

    const newHash = await Bun.password.hash(newPassword);
    updatePassword(user.username, newHash);
    revokeAllSessionsForUser(user.id);

    // The caller's own session was just revoked — issue a fresh one so they stay logged in.
    const session = createSession(user.id, req.socket?.remoteAddress, req.headers["user-agent"]);
    setSessionCookies(res, session.token, session.csrfToken, session.expiresAt);

    log("info", "Admin password changed", { username: user.username, request_id: requestId });
    res.status(200).json({ status: "password_changed", csrf_token: session.csrfToken });
  });

  app.get("/admin-api/auth/sessions", adminAuth, (req: Request, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? null;
    const ctx = req.authContext;
    if (!ctx || ctx.method !== "session" || ctx.userId === undefined) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Requires a session-authenticated user", request_id: requestId } });
      return;
    }
    res.status(200).json({ sessions: listActiveSessionsForUser(ctx.userId) });
  });

  app.delete("/admin-api/auth/sessions/:id", adminAuth, (req: Request<{ id: string }>, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? null;
    const ctx = req.authContext;
    if (!ctx || ctx.method !== "session" || ctx.userId === undefined) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Requires a session-authenticated user", request_id: requestId } });
      return;
    }
    const sessionId = Number(req.params.id);
    if (!Number.isInteger(sessionId)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid session id", request_id: requestId } });
      return;
    }
    const revoked = revokeSessionById(ctx.userId, sessionId);
    if (!revoked) {
      res.status(404).json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found", request_id: requestId } });
      return;
    }
    res.status(200).json({ status: "revoked" });
  });
}
