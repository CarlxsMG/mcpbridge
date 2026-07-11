import { Router, type Request, type Response } from "express";
import {
  getLb,
  setLb,
  addUpstream,
  updateUpstream,
  removeUpstream,
  type LbStrategy,
} from "../../tool-policies/load-balancer.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import { sendError, validationError, bodyOf } from "../http-errors.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";

/**
 * Per-client load-balancing pool: the LB strategy itself (the client's
 * primary still serves traffic, but the pool of N additional "secondary"
 * upstreams is also a target, weighted or failover-style) and the
 * CRUD on each pool member.
 *
 * Selection happens in src/proxy/proxy.ts:selectTarget(); per-member
 * cooldowns live in src/tool-policies/load-balancer.ts. The pool takes
 * precedence over the canary secondary when both are active (LB > canary).
 */
export const lbRoutes = Router();

lbRoutes.get("/clients/:name/lb", (req: Request<{ name: string }>, res: Response) => {
  if (!ensureClientAccess(req, res, req.params.name)) return;
  res.status(200).json({ lb: getLb(req.params.name) });
});

lbRoutes.put("/clients/:name/lb", requireOperator, (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const body = bodyOf(req);
  let input: { strategy: LbStrategy; primaryWeight: number; enabled: boolean } | null;
  if (body.lb === null) {
    input = null;
  } else {
    const strategy = body.strategy as LbStrategy;
    const primaryWeight = typeof body.primaryWeight === "number" ? body.primaryWeight : 1;
    const enabled = body.enabled !== false;
    input = { strategy, primaryWeight, enabled };
  }
  const result = setLb(name, input);
  if (!result.ok) {
    sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.error);
    return;
  }
  recordAudit(
    actorFromRequest(req),
    input ? "client.lb.set" : "client.lb.clear",
    name,
    input ? { strategy: input.strategy, primaryWeight: input.primaryWeight, enabled: input.enabled } : undefined,
  );
  res.status(200).json({ status: "updated", name });
});

lbRoutes.post("/clients/:name/lb/upstreams", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const body = bodyOf(req);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
  const weight = typeof body.weight === "number" ? body.weight : 1;
  if (!baseUrl) {
    validationError(res, "baseUrl is required");
    return;
  }
  const result = await addUpstream(name, baseUrl, weight);
  if (!result.ok) {
    sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.reason ?? result.error);
    return;
  }
  recordAudit(actorFromRequest(req), "client.lb.upstream.add", name, { id: result.id, baseUrl, weight });
  res.status(201).json({ status: "added", id: result.id });
});

lbRoutes.patch(
  "/clients/:name/lb/upstreams/:id",
  requireOperator,
  (req: Request<{ name: string; id: string }>, res: Response) => {
    const { name, id } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const body = bodyOf(req);
    const patch: { enabled?: boolean; weight?: number } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        validationError(res, "enabled must be a boolean");
        return;
      }
      patch.enabled = body.enabled;
    }
    if (body.weight !== undefined) {
      if (typeof body.weight !== "number") {
        validationError(res, "weight must be a number");
        return;
      }
      patch.weight = body.weight;
    }
    const result = updateUpstream(name, Number(id), patch);
    if (!result.ok) {
      sendError(res, result.error === "TARGET_NOT_FOUND" ? 404 : 400, result.error, result.error);
      return;
    }
    recordAudit(actorFromRequest(req), "client.lb.upstream.update", name, { id: Number(id), ...patch });
    res.status(200).json({ status: "updated", id: Number(id) });
  },
);

lbRoutes.delete(
  "/clients/:name/lb/upstreams/:id",
  requireOperator,
  (req: Request<{ name: string; id: string }>, res: Response) => {
    const { name, id } = req.params;
    if (!ensureClientAccess(req, res, name)) return;
    const result = removeUpstream(name, Number(id));
    if (!result.ok) {
      sendError(res, 404, result.error, result.error);
      return;
    }
    recordAudit(actorFromRequest(req), "client.lb.upstream.remove", name, { id: Number(id) });
    res.status(200).json({ status: "removed", id: Number(id) });
  },
);
