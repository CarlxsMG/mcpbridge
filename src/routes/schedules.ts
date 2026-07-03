import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listSchedules, createSchedule, setScheduleEnabled, deleteSchedule } from "../schedules.js";
import { sendError, validationError, notFound } from "./http-errors.js";

export function scheduleRoutes(app: Express): void {
  app.get("/admin-api/schedules", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listSchedules() });
  });

  app.post("/admin-api/schedules", adminAuth, requireOperator, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
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

  app.patch("/admin-api/schedules/:id", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    if (typeof body.enabled !== "boolean") {
      validationError(res, "enabled (boolean) is required");
      return;
    }
    const ok = setScheduleEnabled(Number(req.params.id), body.enabled);
    if (!ok) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.update", `schedule:${req.params.id}`, { enabled: body.enabled });
    res.status(200).json({ status: "updated", id: Number(req.params.id) });
  });

  app.delete("/admin-api/schedules/:id", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteSchedule(Number(req.params.id));
    if (!ok) {
      notFound(res, "SCHEDULE_NOT_FOUND", "Schedule not found");
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.delete", `schedule:${req.params.id}`);
    res.status(200).json({ status: "deleted", id: Number(req.params.id) });
  });
}
