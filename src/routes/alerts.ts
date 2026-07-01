import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  sendTestAlert,
  ALERT_EVENT_TYPES,
  type AlertEventType,
} from "../alerts.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

function isEventType(v: unknown): v is AlertEventType {
  return typeof v === "string" && (ALERT_EVENT_TYPES as string[]).includes(v);
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"));
}

function optNumber(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: v };
  return { ok: false };
}

export function alertRoutes(app: Express): void {
  app.get("/admin-api/alerts", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listAlertRules() });
  });

  app.post("/admin-api/alerts", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name is required (1-128 chars)", request_id: requestId(res) } });
      return;
    }
    if (!isEventType(body.eventType)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `eventType must be one of: ${ALERT_EVENT_TYPES.join(", ")}`, request_id: requestId(res) } });
      return;
    }
    if (!isHttpUrl(body.webhookUrl)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "webhookUrl must be an absolute http(s) URL", request_id: requestId(res) } });
      return;
    }
    const threshold = optNumber(body.threshold);
    const minCalls = optNumber(body.minCalls);
    if (!threshold.ok || !minCalls.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "threshold and minCalls must be numbers", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const rule = createAlertRule({ name, eventType: body.eventType, webhookUrl: body.webhookUrl, threshold: threshold.value, minCalls: minCalls.value, actor });
    recordAudit(actor, "alert.create", String(rule.id), { eventType: rule.eventType });
    res.status(201).json(rule);
  });

  app.patch("/admin-api/alerts/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!getAlertRule(id)) {
      res.status(404).json({ error: { code: "ALERT_NOT_FOUND", message: "Alert rule not found", request_id: requestId(res) } });
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: { name?: string; enabled?: boolean; webhookUrl?: string; threshold?: number | null; minCalls?: number | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name must be a non-empty string", request_id: requestId(res) } });
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled must be a boolean", request_id: requestId(res) } });
        return;
      }
      updates.enabled = body.enabled;
    }
    if (body.webhookUrl !== undefined) {
      if (!isHttpUrl(body.webhookUrl)) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "webhookUrl must be an absolute http(s) URL", request_id: requestId(res) } });
        return;
      }
      updates.webhookUrl = body.webhookUrl;
    }
    if (body.threshold !== undefined) {
      const t = optNumber(body.threshold);
      if (!t.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "threshold must be a number or null", request_id: requestId(res) } }); return; }
      updates.threshold = t.value;
    }
    if (body.minCalls !== undefined) {
      const m = optNumber(body.minCalls);
      if (!m.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "minCalls must be a number or null", request_id: requestId(res) } }); return; }
      updates.minCalls = m.value;
    }
    const rule = updateAlertRule(id, updates);
    recordAudit(actorFromRequest(req), "alert.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(rule);
  });

  app.delete("/admin-api/alerts/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteAlertRule(id)) {
      res.status(404).json({ error: { code: "ALERT_NOT_FOUND", message: "Alert rule not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "alert.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.post("/admin-api/alerts/:id/test", adminAuth, requireAdminRole, async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!getAlertRule(id)) {
      res.status(404).json({ error: { code: "ALERT_NOT_FOUND", message: "Alert rule not found", request_id: requestId(res) } });
      return;
    }
    const result = await sendTestAlert(id);
    recordAudit(actorFromRequest(req), "alert.test", String(id), { ok: result.ok });
    res.status(result.ok ? 200 : 502).json({ status: result.ok ? "sent" : "failed", reason: result.reason });
  });
}
