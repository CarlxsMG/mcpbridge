import { Router } from "express";
import type { Request, Response } from "express";
import { ensureConsumerAccess, requireAdminRole, teamScope } from "../../middleware/authz.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import {
  listConsumers,
  getConsumer,
  consumerNameExists,
  createConsumer,
  updateConsumer,
  deleteConsumer,
  getConsumerUsageThisMonth,
} from "../../admin/entities/consumers.js";
import { sendError, validationError, notFound, bodyOf } from "../http-errors.js";
import { optNumberOrNull } from "../validation.js";

/** A quota/limit: a positive integer, or null for "unlimited". */
const optPositiveIntOrNull = (v: unknown) => optNumberOrNull(v, { integer: true, min: 1 });

export const consumerRoutes = Router();

consumerRoutes.get("/consumers", (req: Request, res: Response) => {
  // Tenancy: a team-scoped caller only sees consumers owned by their own
  // team; super-admins/bearer callers (undefined/null) see all.
  const items = listConsumers({ teamId: teamScope(req) }).map((c) => ({
    ...c,
    usedThisMonth: getConsumerUsageThisMonth(c.id),
  }));
  res.status(200).json({ items });
});

consumerRoutes.post("/consumers", requireAdminRole, (req: Request, res: Response) => {
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
  // Tenancy: a team-scoped caller's consumer is owned by their own team
  // (mirroring how a team-scoped session's other created resources stay
  // within their team); super-admin/bearer callers create an unowned
  // consumer, same default as a newly-registered client.
  //
  // `teamScope(req) ?? null` rather than the helper alone: on WRITE the two
  // "no team" answers still collapse to the same stored value (null = unowned),
  // but the read helper's `undefined` would mean "no filter", which is not a
  // thing a column can hold.
  const consumer = createConsumer({
    name,
    monthlyQuota: quota.value,
    endUserRateLimitPerMin: endUserRateLimit.value,
    actor,
    teamId: teamScope(req) ?? null,
  });
  recordAudit(actor, "consumer.create", String(consumer.id), { name });
  res.status(201).json(consumer);
});

consumerRoutes.patch("/consumers/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
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

consumerRoutes.delete("/consumers/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
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

consumerRoutes.get("/consumers/:id/usage", (req: Request<{ id: string }>, res: Response) => {
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
