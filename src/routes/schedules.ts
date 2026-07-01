import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireOperator } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listSchedules, createSchedule, setScheduleEnabled, deleteSchedule } from "../schedules.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

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

    if ((targetType !== "client" && targetType !== "tool") || !clientName || (action !== "enable" && action !== "disable") || !cron) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "targetType (client|tool), clientName, action (enable|disable) and cron are required", request_id: requestId(res) } });
      return;
    }

    const result = createSchedule({ targetType, clientName, toolName, action, cron, actor: actorFromRequest(req) });
    if (result === "INVALID_CRON") {
      res.status(400).json({ error: { code: "INVALID_CRON", message: "cron must be a valid 5-field expression (min hour dom month dow)", request_id: requestId(res) } });
      return;
    }
    if (result === "INVALID_TARGET") {
      res.status(400).json({ error: { code: "INVALID_TARGET", message: "a tool schedule requires toolName", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.create", `schedule:${result.id}`, { targetType, clientName, toolName, action, cron });
    res.status(201).json(result);
  });

  app.patch("/admin-api/schedules/:id", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled (boolean) is required", request_id: requestId(res) } });
      return;
    }
    const ok = setScheduleEnabled(Number(req.params.id), body.enabled);
    if (!ok) {
      res.status(404).json({ error: { code: "SCHEDULE_NOT_FOUND", message: "Schedule not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.update", `schedule:${req.params.id}`, { enabled: body.enabled });
    res.status(200).json({ status: "updated", id: Number(req.params.id) });
  });

  app.delete("/admin-api/schedules/:id", adminAuth, requireOperator, (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteSchedule(Number(req.params.id));
    if (!ok) {
      res.status(404).json({ error: { code: "SCHEDULE_NOT_FOUND", message: "Schedule not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "schedule.delete", `schedule:${req.params.id}`);
    res.status(200).json({ status: "deleted", id: Number(req.params.id) });
  });
}
