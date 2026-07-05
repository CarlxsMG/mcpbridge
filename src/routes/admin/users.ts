import { Router, type Request, type Response } from "express";
import {
  listUsers,
  findUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  countActiveAdmins,
  isAdminRole,
  type AdminRole,
} from "../../security/user-store.js";
import { revokeAllSessionsForUser } from "../../security/session-store.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import { sendError, validationError, notFound } from "../http-errors.js";
import { requireAdminRole } from "../../middleware/authz.js";

/**
 * Admin-user CRUD. Every handler requires the `admin` role via
 * `requireAdminRole` (read-only listing also demands it; the listing
 * surfaces usernames / roles / last-login timestamps that we don't want
 * leaking to viewer-tier sessions).
 *
 * Routing rule: the "last active admin" invariant is enforced on every
 * mutation that could demote or remove that account. The count check is
 * in-band (`countActiveAdmins()`) — no async DB race because the patch/delete
 * call is the only place that gates on it.
 */
export const usersRoutes = Router();

usersRoutes.get("/users", requireAdminRole, (_req: Request, res: Response) => {
  const users = listUsers().map((u) => ({
    username: u.username,
    role: u.role,
    is_active: u.isActive,
    created_at: u.createdAt,
    last_login_at: u.lastLoginAt,
    team_id: u.teamId,
  }));
  res.status(200).json({ users });
});

usersRoutes.post("/users", requireAdminRole, async (req: Request, res: Response) => {
  const body = (req.body as Record<string, unknown>) ?? {};
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role: AdminRole = isAdminRole(body.role) ? body.role : "admin";

  if (!username || password.length < 12) {
    validationError(res, "username and password (min 12 chars) are required");
    return;
  }
  if (findUserByUsername(username)) {
    sendError(res, 409, "USER_EXISTS", "A user with that username already exists");
    return;
  }

  const hash = await Bun.password.hash(password);
  const actor = actorFromRequest(req);
  const user = createUser(username, hash, role, actor);
  recordAudit(actor, "user.create", user.username, { role });
  res.status(201).json({ username: user.username, role: user.role, is_active: user.isActive });
});

usersRoutes.patch(
  "/users/:username",
  requireAdminRole,
  (req: Request<{ username: string }>, res: Response) => {
    const { username } = req.params;
    const body = (req.body as Record<string, unknown>) ?? {};
    const existing = findUserByUsername(username);
    if (!existing) {
      notFound(res, "USER_NOT_FOUND", "User not found");
      return;
    }

    const nextRole: AdminRole | undefined = isAdminRole(body.role) ? body.role : undefined;
    const nextActive: boolean | undefined = typeof body.is_active === "boolean" ? body.is_active : undefined;

    const wouldLoseAdminStatus =
      existing.role === "admin" &&
      existing.isActive &&
      ((nextRole !== undefined && nextRole !== "admin") || nextActive === false);
    if (wouldLoseAdminStatus && countActiveAdmins() <= 1) {
      sendError(res, 409, "LAST_ADMIN_PROTECTED", "Cannot demote or deactivate the last active admin");
      return;
    }

    updateUser(username, { role: nextRole, isActive: nextActive });
    if (nextActive === false) revokeAllSessionsForUser(existing.id);
    recordAudit(actorFromRequest(req), "user.update", username, { role: nextRole, is_active: nextActive });
    res.status(200).json({ status: "updated", username });
  },
);

usersRoutes.delete(
  "/users/:username",
  requireAdminRole,
  (req: Request<{ username: string }>, res: Response) => {
    const { username } = req.params;
    const existing = findUserByUsername(username);
    if (!existing) {
      notFound(res, "USER_NOT_FOUND", "User not found");
      return;
    }
    if (existing.role === "admin" && existing.isActive && countActiveAdmins() <= 1) {
      sendError(res, 409, "LAST_ADMIN_PROTECTED", "Cannot delete the last active admin");
      return;
    }
    deleteUser(username); // cascades admin_sessions via FK
    recordAudit(actorFromRequest(req), "user.delete", username);
    res.status(200).json({ status: "deleted", username });
  },
);
