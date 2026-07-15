import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, canCallerAccessClient } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listGuardPolicies,
  getGuardPolicy,
  createGuardPolicy,
  updateGuardPolicy,
  deleteGuardPolicy,
  policyNameExists,
  applyPolicyToTools,
  applyPolicyToBundle,
} from "../admin/entities/policies.js";
import type { BundleToolRef } from "../admin/tool-composition/bundles.js";
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";
import type { LooseValidationResult } from "./validation.js";

/** Accepts a positive number, or null (clears the guard). Rejects anything else. */
function optPositiveOrNull(v: unknown): LooseValidationResult<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

function validateToolRefs(input: unknown): LooseValidationResult<BundleToolRef[]> {
  if (!Array.isArray(input)) return { ok: false };
  const value: BundleToolRef[] = [];
  for (const item of input) {
    const e = item as Record<string, unknown>;
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.client !== "string" ||
      typeof e.tool !== "string" ||
      !e.client ||
      !e.tool
    ) {
      return { ok: false };
    }
    value.push({ client: e.client, tool: e.tool });
  }
  return { ok: true, value };
}

export function policyRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/policies", (_req: Request, res: Response) => {
    res.status(200).json({ items: listGuardPolicies() });
  });

  r.post("/policies", requireAdminRole, (req: Request, res: Response) => {
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
    const timeout = optPositiveOrNull(body.timeoutMs);
    if (!rate.ok || !timeout.ok) {
      validationError(res, "rateLimitPerMin and timeoutMs must be positive numbers or null");
      return;
    }
    const actor = actorFromRequest(req);
    const policy = createGuardPolicy({ name, rateLimitPerMin: rate.value, timeoutMs: timeout.value, actor });
    recordAudit(actor, "policy.create", String(policy.id), { name });
    res.status(201).json(policy);
  });

  r.patch("/policies/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
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
      const t = optPositiveOrNull(body.timeoutMs);
      if (!t.ok) {
        validationError(res, "timeoutMs must be a positive number or null");
        return;
      }
      updates.timeoutMs = t.value;
    }
    const policy = updateGuardPolicy(id, updates);
    recordAudit(actorFromRequest(req), "policy.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(policy);
  });

  r.delete("/policies/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteGuardPolicy(id)) {
      notFound(res, "POLICY_NOT_FOUND", "Policy not found");
      return;
    }
    recordAudit(actorFromRequest(req), "policy.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  r.post("/policies/:id/apply", requireAdminRole, async (req: Request<{ id: string }>, res: Response) => {
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

    const refs = validateToolRefs(body.tools);
    if (!refs.ok) {
      validationError(res, "provide either bundle (string) or tools ([{client, tool}])");
      return;
    }
    const result = await applyPolicyToTools(policy, refs.value, isAllowed);
    recordAudit(actor, "policy.apply", String(id), { tools: refs.value.length, applied: result.applied });
    res.status(200).json(result);
  });

  app.use("/admin-api", r);
}
