import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listTeams, createTeam, deleteTeam, setClientTeam, setUserTeam } from "../teams.js";
import { sendError, validationError, notFound } from "./http-errors.js";

export function teamRoutes(app: Express): void {
  // Any admin may read the team list (needed for assignment dropdowns).
  app.get("/admin-api/teams", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listTeams() });
  });

  app.post("/admin-api/teams", adminAuth, requireSuperAdmin, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      validationError(res, "name is required");
      return;
    }
    const result = createTeam(name, actorFromRequest(req));
    if (result === "INVALID_NAME") {
      sendError(res, 400, "INVALID_NAME", "Team name must be 1-63 chars: letters, digits, space, - or _");
      return;
    }
    if (result === "ALREADY_EXISTS") {
      sendError(res, 409, "ALREADY_EXISTS", "A team with that name already exists");
      return;
    }
    recordAudit(actorFromRequest(req), "team.create", `team:${result.id}`, { name: result.name });
    res.status(201).json(result);
  });

  app.delete("/admin-api/teams/:id", adminAuth, requireSuperAdmin, (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteTeam(Number(req.params.id));
    if (!ok) {
      notFound(res, "TEAM_NOT_FOUND", "Team not found");
      return;
    }
    recordAudit(actorFromRequest(req), "team.delete", `team:${req.params.id}`);
    res.status(200).json({ status: "deleted", id: Number(req.params.id) });
  });

  // Assign (or clear) a client's owning team.
  app.put(
    "/admin-api/clients/:name/team",
    adminAuth,
    requireSuperAdmin,
    (req: Request<{ name: string }>, res: Response) => {
      const body = (req.body as Record<string, unknown>) ?? {};
      const teamId = body.teamId === null ? null : typeof body.teamId === "number" ? body.teamId : undefined;
      if (teamId === undefined) {
        validationError(res, "teamId must be a number or null");
        return;
      }
      const ok = setClientTeam(req.params.name, teamId);
      if (!ok) {
        notFound(res, "NOT_FOUND", "Client or team not found");
        return;
      }
      recordAudit(actorFromRequest(req), "client.team.set", req.params.name, { teamId });
      res.status(200).json({ status: "updated", name: req.params.name, teamId });
    },
  );

  // Assign (or clear) a user's team membership.
  app.put(
    "/admin-api/users/:username/team",
    adminAuth,
    requireSuperAdmin,
    (req: Request<{ username: string }>, res: Response) => {
      const body = (req.body as Record<string, unknown>) ?? {};
      const teamId = body.teamId === null ? null : typeof body.teamId === "number" ? body.teamId : undefined;
      if (teamId === undefined) {
        validationError(res, "teamId must be a number or null");
        return;
      }
      const ok = setUserTeam(req.params.username, teamId);
      if (!ok) {
        notFound(res, "NOT_FOUND", "User or team not found");
        return;
      }
      recordAudit(actorFromRequest(req), "user.team.set", req.params.username, { teamId });
      res.status(200).json({ status: "updated", username: req.params.username, teamId });
    },
  );
}
