import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator, ensureClientAccess, callerTeamId } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listSchedules,
  createSchedule,
  setScheduleEnabled,
  deleteSchedule,
  getSchedule,
} from "../admin/entities/schedules.js";
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";

export function scheduleRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/schedules", (req: Request, res: Response) => {
    const teamId = callerTeamId(req);
    // Tenancy: a team-scoped caller only sees schedules targeting their own
    // team's clients; super-admins/bearer callers (undefined/null) see all.
    res.status(200).json({ items: listSchedules({ teamId: typeof teamId === "number" ? teamId : undefined }) });
  });

  r.post("/schedules", requireOperator, (req: Request, res: Response) => {
    const body = bodyOf(req);
    const targetType = body.targetType;
    const clientName = typeof body.clientName === "string" ? body.clientName : "";
    const toolName = typeof body.toolName === "string" ? body.toolName : null;
    const action = body.action;
    const cron = typeof body.cron === "string" ? body.cron : "";

    if (
      (targetType !== "client" && targetType !== "tool") ||
      !clientName ||
      (action !== "enable" && action !== "disable") ||
      !cron
    ) {
      validationError(res, "targetType (client|tool), clientName, action (enable|disable) and cron are required");
      return;
    }
    // Tenancy: a team-scoped caller can't schedule an enable/disable against a
    // client outside their team.
    if (!ensureClientAccess(req, res, clientName)) return;

    const result = createSchedule({ targetType, clientName, toolName, action, cron, actor: actorFromRequest(req) });
    if (result === "INVALID_CRON") {
      sendError(res, 400, "INVALID_CRON", "cron must be a valid 5-field expression (min hour dom month dow)");
      return;
    }
    if (result === "INVALID_TARGET") {
      sendError(res, 400, "INVALID_TARGET", "a tool schedule requires toolName");
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.create", `schedule:${result.id}`, {
      targetType,
      clientName,
      toolName,
      action,
      cron,
    });
    res.status(201).json(result);
  });

  r.patch("/schedules/:id", requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const body = bodyOf(req);
    if (typeof body.enabled !== "boolean") {
      validationError(res, "enabled (boolean) is required");
      return;
    }
    const id = Number(req.params.id);
    const existing = getSchedule(id);
    if (!existing) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    // Tenancy: a team-scoped caller can't enable/disable a schedule targeting
    // another team's client — same uniform 404 as a genuinely-missing schedule.
    if (!ensureClientAccess(req, res, existing.clientName)) return;
    const ok = setScheduleEnabled(id, body.enabled);
    if (!ok) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.update", `schedule:${id}`, { enabled: body.enabled });
    res.status(200).json({ status: "updated", id });
  });

  r.delete("/schedules/:id", requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getSchedule(id);
    if (!existing) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    // Tenancy: a team-scoped caller can't delete another team's schedule.
    if (!ensureClientAccess(req, res, existing.clientName)) return;
    const ok = deleteSchedule(id);
    if (!ok) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.delete", `schedule:${id}`);
    res.status(200).json({ status: "deleted", id });
  });

  app.use("/admin-api", r);
}
