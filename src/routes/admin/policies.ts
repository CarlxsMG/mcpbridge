import { Router } from "express";
import type { Request, Response } from "express";
import { requireAdminRole, canCallerAccessClient } from "../../middleware/authz.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import {
  listGuardPolicies,
  getGuardPolicy,
  createGuardPolicy,
  updateGuardPolicy,
  deleteGuardPolicy,
  policyNameExists,
  applyPolicyToTools,
  applyPolicyToBundle,
} from "../../admin/entities/policies.js";
import { sendError, validationError, notFound, bodyOf } from "../http-errors.js";
import { MAX_GUARD_TIMEOUT_MS, optNumberOrNull, parseToolRefs } from "../validation.js";

/** A policy guard value: a positive number, or null to clear it. */
const optPositiveOrNull = (v: unknown) => optNumberOrNull(v, { min: Number.MIN_VALUE });

/**
 * As above, but capped — a policy's timeoutMs substitutes for
 * `config.toolCallTimeoutMs` at dispatch exactly like a per-tool guard does, so
 * it gets the same ceiling instead of being able to escape the env schema's.
 */
const optTimeoutOrNull = (v: unknown) => optNumberOrNull(v, { min: Number.MIN_VALUE, max: MAX_GUARD_TIMEOUT_MS });

export const policyRoutes = Router();

policyRoutes.get("/policies", (_req: Request, res: Response) => {
  res.status(200).json({ items: listGuardPolicies() });
});

policyRoutes.post("/policies", requireAdminRole, (req: Request, res: Response) => {
  const body = bodyOf(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 128) {
    validationError(res, "name is required (1-128 chars)");
    return;
  }
  if (policyNameExists(name)) {
    sendError(res, 409, "POLICY_EXISTS", "A policy with that name already exists");
    return;
  }
  const rate = optPositiveOrNull(body.rateLimitPerMin);
  const timeout = optTimeoutOrNull(body.timeoutMs);
  if (!rate.ok || !timeout.ok) {
    validationError(
      res,
      `rateLimitPerMin and timeoutMs must be positive numbers or null (timeoutMs at most ${MAX_GUARD_TIMEOUT_MS} ms)`,
    );
    return;
  }
  const actor = actorFromRequest(req);
  const policy = createGuardPolicy({ name, rateLimitPerMin: rate.value, timeoutMs: timeout.value, actor });
  recordAudit(actor, "policy.create", String(policy.id), { name });
  res.status(201).json(policy);
});

policyRoutes.patch("/policies/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
  const id = Number(req.params.id);
  const existing = getGuardPolicy(id);
  if (!existing) {
    notFound(res, "POLICY_NOT_FOUND", "Policy not found");
    return;
  }
  const body = bodyOf(req);
  const updates: { name?: string; rateLimitPerMin?: number | null; timeoutMs?: number | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      validationError(res, "name must be a non-empty string");
      return;
    }
    if (body.name.trim() !== existing.name && policyNameExists(body.name.trim())) {
      sendError(res, 409, "POLICY_EXISTS", "A policy with that name already exists");
      return;
    }
    updates.name = body.name.trim();
  }
  if (body.rateLimitPerMin !== undefined) {
    const r = optPositiveOrNull(body.rateLimitPerMin);
    if (!r.ok) {
      validationError(res, "rateLimitPerMin must be a positive number or null");
      return;
    }
    updates.rateLimitPerMin = r.value;
  }
  if (body.timeoutMs !== undefined) {
    const t = optTimeoutOrNull(body.timeoutMs);
    if (!t.ok) {
      validationError(res, `timeoutMs must be a positive number or null, at most ${MAX_GUARD_TIMEOUT_MS} ms`);
      return;
    }
    updates.timeoutMs = t.value;
  }
  const policy = updateGuardPolicy(id, updates);
  recordAudit(actorFromRequest(req), "policy.update", String(id), { fields: Object.keys(updates) });
  res.status(200).json(policy);
});

policyRoutes.delete("/policies/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
  const id = Number(req.params.id);
  if (!deleteGuardPolicy(id)) {
    notFound(res, "POLICY_NOT_FOUND", "Policy not found");
    return;
  }
  recordAudit(actorFromRequest(req), "policy.delete", String(id));
  res.status(200).json({ status: "deleted", id });
});

policyRoutes.post("/policies/:id/apply", requireAdminRole, async (req: Request<{ id: string }>, res: Response) => {
  const id = Number(req.params.id);
  const policy = getGuardPolicy(id);
  if (!policy) {
    notFound(res, "POLICY_NOT_FOUND", "Policy not found");
    return;
  }
  const body = bodyOf(req);
  const actor = actorFromRequest(req);
  // Tenancy: a team-scoped admin may only apply guards to clients their team
  // owns. Refs outside the caller's team are reported as skipped/"not found"
  // (see applyPolicyToTools), the same way `ensureClientAccess` hides a
  // cross-team client behind a uniform 404 elsewhere in this codebase.
  const isAllowed = (clientName: string): boolean => canCallerAccessClient(req, clientName);

  if (typeof body.bundle === "string" && body.bundle) {
    const result = await applyPolicyToBundle(policy, body.bundle, isAllowed);
    if (result === null) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
      return;
    }
    recordAudit(actor, "policy.apply", String(id), { bundle: body.bundle, applied: result.applied });
    res.status(200).json(result);
    return;
  }

  const refs = parseToolRefs(body.tools);
  if (!refs.ok) {
    validationError(res, "provide either bundle (string) or tools ([{client, tool}])");
    return;
  }
  const result = await applyPolicyToTools(policy, refs.value, isAllowed);
  recordAudit(actor, "policy.apply", String(id), { tools: refs.value.length, applied: result.applied });
  res.status(200).json(result);
});
