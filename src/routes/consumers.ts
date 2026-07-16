import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, callerTeamId, ensureConsumerAccess } from "../middleware/authz.js";
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
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";
import type { LooseValidationResult } from "./validation.js";

function optPositiveIntOrNull(v: unknown): LooseValidationResult<number | null> {
  if (!isValidQuotaValue(v)) return { ok: false };
  return { ok: true, value: v ?? null };
}

export function consumerRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/consumers", (req: Request, res: Response) => {
    const teamId = callerTeamId(req);
    // Tenancy: a team-scoped caller only sees consumers owned by their own
    // team; super-admins/bearer callers (undefined/null) see all.
    const items = listConsumers({ teamId: typeof teamId === "number" ? teamId : undefined }).map((c) => ({
      ...c,
      usedThisMonth: getConsumerUsageThisMonth(c.id),
    }));
    res.status(200).json({ items });
  });

  r.post("/consumers", requireAdminRole, (req: Request, res: Response) => {
    const body = bodyOf(req);
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
    const teamId = callerTeamId(req);
    // Tenancy: a team-scoped caller's consumer is owned by their own team
    // (mirroring how a team-scoped session's other created resources stay
    // within their team); super-admin/bearer callers create an unowned
    // consumer, same default as a newly-registered client.
    const consumer = createConsumer({
      name,
      monthlyQuota: quota.value,
      endUserRateLimitPerMin: endUserRateLimit.value,
      actor,
      teamId: typeof teamId === "number" ? teamId : null,
    });
    recordAudit(actor, "consumer.create", String(consumer.id), { name });
    res.status(201).json(consumer);
  });

  r.patch("/consumers/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getConsumer(id);
    if (!existing) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    // Tenancy: a team-scoped caller can't mutate another team's (or an
    // unowned) consumer — same uniform 404 as a genuinely-missing id.
    if (!ensureConsumerAccess(req, res, id)) return;
    const body = bodyOf(req);
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

  r.delete("/consumers/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!getConsumer(id)) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    // Tenancy: a team-scoped caller can't delete another team's (or an
    // unowned) consumer — same uniform 404 as a genuinely-missing id.
    if (!ensureConsumerAccess(req, res, id)) return;
    if (!deleteConsumer(id)) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    recordAudit(actorFromRequest(req), "consumer.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  r.get("/consumers/:id/usage", (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const consumer = getConsumer(id);
    if (!consumer) {
      notFound(res, "CONSUMER_NOT_FOUND", "Consumer not found");
      return;
    }
    // Tenancy: a team-scoped caller can't read another team's (or an
    // unowned) consumer's usage — same uniform 404 as a genuinely-missing id.
    if (!ensureConsumerAccess(req, res, id)) return;
    res.status(200).json({ used: getConsumerUsageThisMonth(id), quota: consumer.monthlyQuota });
  });

  app.use("/admin-api", r);
}
