import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import {
  listConsumers,
  getConsumer,
  consumerNameExists,
  createConsumer,
  updateConsumer,
  deleteConsumer,
  getConsumerUsageThisMonth,
} from "../consumers.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

function optPositiveIntOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

export function consumerRoutes(app: Express): void {
  app.get("/admin-api/consumers", adminAuth, (_req: Request, res: Response) => {
    const items = listConsumers().map((c) => ({ ...c, usedThisMonth: getConsumerUsageThisMonth(c.id) }));
    res.status(200).json({ items });
  });

  app.post("/admin-api/consumers", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name is required (1-128 chars)", request_id: requestId(res) } });
      return;
    }
    if (consumerNameExists(name)) {
      res.status(409).json({ error: { code: "CONSUMER_EXISTS", message: "A consumer with that name already exists", request_id: requestId(res) } });
      return;
    }
    const quota = optPositiveIntOrNull(body.monthlyQuota);
    if (!quota.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "monthlyQuota must be a positive integer or null", request_id: requestId(res) } });
      return;
    }
    const endUserRateLimit = optPositiveIntOrNull(body.endUserRateLimitPerMin);
    if (!endUserRateLimit.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "endUserRateLimitPerMin must be a positive integer or null", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const consumer = createConsumer({ name, monthlyQuota: quota.value, endUserRateLimitPerMin: endUserRateLimit.value, actor });
    recordAudit(actor, "consumer.create", String(consumer.id), { name });
    res.status(201).json(consumer);
  });

  app.patch("/admin-api/consumers/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getConsumer(id);
    if (!existing) {
      res.status(404).json({ error: { code: "CONSUMER_NOT_FOUND", message: "Consumer not found", request_id: requestId(res) } });
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: { name?: string; monthlyQuota?: number | null; endUserRateLimitPerMin?: number | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name must be a non-empty string", request_id: requestId(res) } });
        return;
      }
      if (body.name.trim() !== existing.name && consumerNameExists(body.name.trim())) {
        res.status(409).json({ error: { code: "CONSUMER_EXISTS", message: "A consumer with that name already exists", request_id: requestId(res) } });
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.monthlyQuota !== undefined) {
      const q = optPositiveIntOrNull(body.monthlyQuota);
      if (!q.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "monthlyQuota must be a positive integer or null", request_id: requestId(res) } }); return; }
      updates.monthlyQuota = q.value;
    }
    if (body.endUserRateLimitPerMin !== undefined) {
      const l = optPositiveIntOrNull(body.endUserRateLimitPerMin);
      if (!l.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "endUserRateLimitPerMin must be a positive integer or null", request_id: requestId(res) } }); return; }
      updates.endUserRateLimitPerMin = l.value;
    }
    const consumer = updateConsumer(id, updates);
    recordAudit(actorFromRequest(req), "consumer.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(consumer);
  });

  app.delete("/admin-api/consumers/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteConsumer(id)) {
      res.status(404).json({ error: { code: "CONSUMER_NOT_FOUND", message: "Consumer not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "consumer.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.get("/admin-api/consumers/:id/usage", adminAuth, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const consumer = getConsumer(id);
    if (!consumer) {
      res.status(404).json({ error: { code: "CONSUMER_NOT_FOUND", message: "Consumer not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json({ used: getConsumerUsageThisMonth(id), quota: consumer.monthlyQuota });
  });
}
