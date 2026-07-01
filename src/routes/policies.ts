import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import {
  listGuardPolicies,
  getGuardPolicy,
  createGuardPolicy,
  updateGuardPolicy,
  deleteGuardPolicy,
  policyNameExists,
  applyPolicyToTools,
  applyPolicyToBundle,
} from "../policies.js";
import type { BundleToolRef } from "../bundles.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

/** Accepts a positive number, or null (clears the guard). Rejects anything else. */
function optPositiveOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

function validateToolRefs(input: unknown): { ok: true; value: BundleToolRef[] } | { ok: false } {
  if (!Array.isArray(input)) return { ok: false };
  const value: BundleToolRef[] = [];
  for (const item of input) {
    const e = item as Record<string, unknown>;
    if (typeof e !== "object" || e === null || typeof e.client !== "string" || typeof e.tool !== "string" || !e.client || !e.tool) {
      return { ok: false };
    }
    value.push({ client: e.client, tool: e.tool });
  }
  return { ok: true, value };
}

export function policyRoutes(app: Express): void {
  app.get("/admin-api/policies", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listGuardPolicies() });
  });

  app.post("/admin-api/policies", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name is required (1-128 chars)", request_id: requestId(res) } });
      return;
    }
    if (policyNameExists(name)) {
      res.status(409).json({ error: { code: "POLICY_EXISTS", message: "A policy with that name already exists", request_id: requestId(res) } });
      return;
    }
    const rate = optPositiveOrNull(body.rateLimitPerMin);
    const timeout = optPositiveOrNull(body.timeoutMs);
    if (!rate.ok || !timeout.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "rateLimitPerMin and timeoutMs must be positive numbers or null", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const policy = createGuardPolicy({ name, rateLimitPerMin: rate.value, timeoutMs: timeout.value, actor });
    recordAudit(actor, "policy.create", String(policy.id), { name });
    res.status(201).json(policy);
  });

  app.patch("/admin-api/policies/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getGuardPolicy(id);
    if (!existing) {
      res.status(404).json({ error: { code: "POLICY_NOT_FOUND", message: "Policy not found", request_id: requestId(res) } });
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: { name?: string; rateLimitPerMin?: number | null; timeoutMs?: number | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name must be a non-empty string", request_id: requestId(res) } });
        return;
      }
      if (body.name.trim() !== existing.name && policyNameExists(body.name.trim())) {
        res.status(409).json({ error: { code: "POLICY_EXISTS", message: "A policy with that name already exists", request_id: requestId(res) } });
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.rateLimitPerMin !== undefined) {
      const r = optPositiveOrNull(body.rateLimitPerMin);
      if (!r.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "rateLimitPerMin must be a positive number or null", request_id: requestId(res) } }); return; }
      updates.rateLimitPerMin = r.value;
    }
    if (body.timeoutMs !== undefined) {
      const t = optPositiveOrNull(body.timeoutMs);
      if (!t.ok) { res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "timeoutMs must be a positive number or null", request_id: requestId(res) } }); return; }
      updates.timeoutMs = t.value;
    }
    const policy = updateGuardPolicy(id, updates);
    recordAudit(actorFromRequest(req), "policy.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(policy);
  });

  app.delete("/admin-api/policies/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!deleteGuardPolicy(id)) {
      res.status(404).json({ error: { code: "POLICY_NOT_FOUND", message: "Policy not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "policy.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.post("/admin-api/policies/:id/apply", adminAuth, requireAdminRole, async (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const policy = getGuardPolicy(id);
    if (!policy) {
      res.status(404).json({ error: { code: "POLICY_NOT_FOUND", message: "Policy not found", request_id: requestId(res) } });
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const actor = actorFromRequest(req);

    if (typeof body.bundle === "string" && body.bundle) {
      const result = await applyPolicyToBundle(policy, body.bundle);
      if (result === null) {
        res.status(404).json({ error: { code: "BUNDLE_NOT_FOUND", message: "Bundle not found", request_id: requestId(res) } });
        return;
      }
      recordAudit(actor, "policy.apply", String(id), { bundle: body.bundle, applied: result.applied });
      res.status(200).json(result);
      return;
    }

    const refs = validateToolRefs(body.tools);
    if (!refs.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "provide either bundle (string) or tools ([{client, tool}])", request_id: requestId(res) } });
      return;
    }
    const result = await applyPolicyToTools(policy, refs.value);
    recordAudit(actor, "policy.apply", String(id), { tools: refs.value.length, applied: result.applied });
    res.status(200).json(result);
  });
}
