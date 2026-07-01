import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listTeams, createTeam, deleteTeam, setClientTeam, setUserTeam } from "../teams.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

export function teamRoutes(app: Express): void {
  // Any admin may read the team list (needed for assignment dropdowns).
  app.get("/admin-api/teams", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listTeams() });
  });

  app.post("/admin-api/teams", adminAuth, requireSuperAdmin, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name is required", request_id: requestId(res) } });
      return;
    }
    const result = createTeam(name, actorFromRequest(req));
    if (result === "INVALID_NAME") {
      res.status(400).json({ error: { code: "INVALID_NAME", message: "Team name must be 1-63 chars: letters, digits, space, - or _", request_id: requestId(res) } });
      return;
    }
    if (result === "ALREADY_EXISTS") {
      res.status(409).json({ error: { code: "ALREADY_EXISTS", message: "A team with that name already exists", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "team.create", `team:${result.id}`, { name: result.name });
    res.status(201).json(result);
  });

  app.delete("/admin-api/teams/:id", adminAuth, requireSuperAdmin, (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteTeam(Number(req.params.id));
    if (!ok) {
      res.status(404).json({ error: { code: "TEAM_NOT_FOUND", message: "Team not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "team.delete", `team:${req.params.id}`);
    res.status(200).json({ status: "deleted", id: Number(req.params.id) });
  });

  // Assign (or clear) a client's owning team.
  app.put("/admin-api/clients/:name/team", adminAuth, requireSuperAdmin, (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const teamId = body.teamId === null ? null : typeof body.teamId === "number" ? body.teamId : undefined;
    if (teamId === undefined) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "teamId must be a number or null", request_id: requestId(res) } });
      return;
    }
    const ok = setClientTeam(req.params.name, teamId);
    if (!ok) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Client or team not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "client.team.set", req.params.name, { teamId });
    res.status(200).json({ status: "updated", name: req.params.name, teamId });
  });

  // Assign (or clear) a user's team membership.
  app.put("/admin-api/users/:username/team", adminAuth, requireSuperAdmin, (req: Request<{ username: string }>, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const teamId = body.teamId === null ? null : typeof body.teamId === "number" ? body.teamId : undefined;
    if (teamId === undefined) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "teamId must be a number or null", request_id: requestId(res) } });
      return;
    }
    const ok = setUserTeam(req.params.username, teamId);
    if (!ok) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "User or team not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "user.team.set", req.params.username, { teamId });
    res.status(200).json({ status: "updated", username: req.params.username, teamId });
  });
}
