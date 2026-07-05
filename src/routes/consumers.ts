import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listConsumers,
  getConsumer,
  consumerNameExists,
  createConsumer,
  updateConsumer,
  deleteConsumer,
  getConsumerUsageThisMonth,
  isValidQuotaValue,
} from "../admin/entities/consumers.js";
import { sendError, validationError, notFound } from "./http-errors.js";

function optPositiveIntOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (!isValidQuotaValue(v)) return { ok: false };
  return { ok: true, value: v ?? null };
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
      validationError(res, "name is required (1-128 chars)");
      return;
    }
    if (consumerNameExists(name)) {
      sendError(res, 409, "CONSUMER_EXISTS", "A consumer with that name already exists");
      return;
    }
    const quota = optPositiveIntOrNull(body.monthlyQuota);
    if (!quota.ok) {
      validationError(res, "monthlyQuota must be a positive integer or null");
      return;
    }
    const endUserRateLimit = optPositiveIntOrNull(body.endUserRateLimitPerMin);
    if (!endUserRateLimit.ok) {
      validationError(res, "endUserRateLimitPerMin must be a positive integer or null");
      return;
    }
    const actor = actorFromRequest(req);
    const consumer = createConsumer({
      name,
      monthlyQuota: quota.value,
      endUserRateLimitPerMin: endUserRateLimit.value,
      actor,
    });
    recordAudit(actor, "consumer.create", String(consumer.id), { name });
    res.status(201).json(consumer);
  });

  app.patch("/admin-api/consumers/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getConsumer(id);
    if (!existing) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: { name?: string; monthlyQuota?: number | null; endUserRateLimitPerMin?: number | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        validationError(res, "name must be a non-empty string");
        return;
      }
      if (body.name.trim() !== existing.name && consumerNameExists(body.name.trim())) {
        sendError(res, 409, "CONSUMER_EXISTS", "A consumer with that name already exists");
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.monthlyQuota !== undefined) {
      const q = optPositiveIntOrNull(body.monthlyQuota);
      if (!q.ok) {
        validationError(res, "monthlyQuota must be a positive integer or null");
        return;
      }
      updates.monthlyQuota = q.value;
    }
    if (body.endUserRateLimitPerMin !== undefined) {
      const l = optPositiveIntOrNull(body.endUserRateLimitPerMin);
      if (!l.ok) {
        validationError(res, "endUserRateLimitPerMin must be a positive integer or null");
        return;
      }
      updates.endUserRateLimitPerMin = l.value;
    }
    const consumer = updateConsumer(id, updates);
    recordAudit(actorFromRequest(req), "consumer.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(consumer);
  });

  app.delete("/admin-api/consumers/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteConsumer(id)) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    recordAudit(actorFromRequest(req), "consumer.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.get("/admin-api/consumers/:id/usage", adminAuth, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const consumer = getConsumer(id);
    if (!consumer) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    res.status(200).json({ used: getConsumerUsageThisMonth(id), quota: consumer.monthlyQuota });
  });
}
