import { Router, type Request, type Response } from "express";
import { getCanary, setCanary } from "../../tool-policies/canary.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import { sendError, validationError } from "../http-errors.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";

/**
 * Per-client canary / failover config. Each registered client may carry
 * a "secondary" upstream base URL plus a routing mode (canary → weighted
 * split, or failover → secondary only when primary breaker is open).
 * The proxy reads this in src/proxy/proxy.ts:decideSecondary().
 *
 * Storage is in-memory; configuration is per-instance. Cross-instance
 * propagation would need to be added if running HA.
 */
export const canaryRoutes = Router();

canaryRoutes.get("/clients/:name/canary", (req: Request<{ name: string }>, res: Response) => {
  if (!ensureClientAccess(req, res, req.params.name)) return;
  res.status(200).json({ canary: getCanary(req.params.name) });
});

canaryRoutes.put("/clients/:name/canary", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const body = (req.body as Record<string, unknown>) ?? {};
  let input: { secondaryBaseUrl: string; mode: "canary" | "failover"; weight: number; enabled: boolean } | null;
  if (body.canary === null) {
    input = null;
  } else {
    const secondaryBaseUrl = typeof body.secondaryBaseUrl === "string" ? body.secondaryBaseUrl : "";
    const mode = body.mode === "failover" ? "failover" : "canary";
    const weight = typeof body.weight === "number" ? body.weight : 0;
    const enabled = body.enabled !== false;
    if (!secondaryBaseUrl) {
      validationError(res, "secondaryBaseUrl is required (or send { canary: null } to clear)");
      return;
    }
    input = { secondaryBaseUrl, mode, weight, enabled };
  }

  const result = await setCanary(name, input);
  if (!result.ok) {
    sendError(res, result.error === "CLIENT_NOT_FOUND" ? 404 : 400, result.error, result.reason ?? result.error);
    return;
  }
  recordAudit(
    actorFromRequest(req),
    input ? "client.canary.set" : "client.canary.clear",
    name,
    input ? { mode: input.mode, weight: input.weight, enabled: input.enabled } : undefined,
  );
  res.status(200).json({ status: "updated", name });
});
