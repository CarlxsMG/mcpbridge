import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  sendTestAlert,
  ALERT_EVENT_TYPES,
  type AlertEventType,
} from "../observability/alerts.js";
import { validationError, notFound } from "./http-errors.js";

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
      validationError(res, "name is required (1-128 chars)");
      return;
    }
    if (!isEventType(body.eventType)) {
      validationError(res, `eventType must be one of: ${ALERT_EVENT_TYPES.join(", ")}`);
      return;
    }
    if (!isHttpUrl(body.webhookUrl)) {
      validationError(res, "webhookUrl must be an absolute http(s) URL");
      return;
    }
    const threshold = optNumber(body.threshold);
    const minCalls = optNumber(body.minCalls);
    if (!threshold.ok || !minCalls.ok) {
      validationError(res, "threshold and minCalls must be numbers");
      return;
    }
    const actor = actorFromRequest(req);
    const rule = createAlertRule({
      name,
      eventType: body.eventType,
      webhookUrl: body.webhookUrl,
      threshold: threshold.value,
      minCalls: minCalls.value,
      actor,
    });
    recordAudit(actor, "alert.create", String(rule.id), { eventType: rule.eventType });
    res.status(201).json(rule);
  });

  app.patch("/admin-api/alerts/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!getAlertRule(id)) {
      notFound(res, "ALERT_NOT_FOUND", "Alert rule not found");
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: {
      name?: string;
      enabled?: boolean;
      webhookUrl?: string;
      threshold?: number | null;
      minCalls?: number | null;
    } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        validationError(res, "name must be a non-empty string");
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        validationError(res, "enabled must be a boolean");
        return;
      }
      updates.enabled = body.enabled;
    }
    if (body.webhookUrl !== undefined) {
      if (!isHttpUrl(body.webhookUrl)) {
        validationError(res, "webhookUrl must be an absolute http(s) URL");
        return;
      }
      updates.webhookUrl = body.webhookUrl;
    }
    if (body.threshold !== undefined) {
      const t = optNumber(body.threshold);
      if (!t.ok) {
        validationError(res, "threshold must be a number or null");
        return;
      }
      updates.threshold = t.value;
    }
    if (body.minCalls !== undefined) {
      const m = optNumber(body.minCalls);
      if (!m.ok) {
        validationError(res, "minCalls must be a number or null");
        return;
      }
      updates.minCalls = m.value;
    }
    const rule = updateAlertRule(id, updates);
    recordAudit(actorFromRequest(req), "alert.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(rule);
  });

  app.delete("/admin-api/alerts/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteAlertRule(id)) {
      notFound(res, "ALERT_NOT_FOUND", "Alert rule not found");
      return;
    }
    recordAudit(actorFromRequest(req), "alert.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.post(
    "/admin-api/alerts/:id/test",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ id: string }>, res: Response) => {
      const id = Number(req.params.id);
      if (!getAlertRule(id)) {
        notFound(res, "ALERT_NOT_FOUND", "Alert rule not found");
        return;
      }
      const result = await sendTestAlert(id);
      recordAudit(actorFromRequest(req), "alert.test", String(id), { ok: result.ok });
      res.status(result.ok ? 200 : 502).json({ status: result.ok ? "sent" : "failed", reason: result.reason });
    },
  );
}
