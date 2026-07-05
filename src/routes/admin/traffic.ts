import { Router, type Request, type Response } from "express";
import { listTraffic, getTraffic } from "../../observability/traffic.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import { notFound } from "../http-errors.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";

/**
 * Traffic explorer: list captured call records (opt-in via
 * TRAFFIC_CAPTURE), fetch a single record by id, re-execute it through
 * the regular proxy pipeline.
 *
 * Replay runs the recorded args through `proxyToolCall`, so every guard
 * in src/proxy/pipeline.ts (quota, scope, sensitivity, rate-limit,
 * breaker, redaction, audit) re-applies — a replay is never an
 * authenticated-bypass shortcut; it's a fresh tool call carrying
 * the operator's session.
 */
export const trafficRoutes = Router();

trafficRoutes.get("/traffic", (req: Request, res: Response) => {
  const clientName = typeof req.query.client === "string" ? req.query.client : undefined;
  const toolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
  const errorsOnly = req.query.errors === "true";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  res.status(200).json(listTraffic({ clientName, toolName, errorsOnly, cursor, limit }));
});

trafficRoutes.get("/traffic/:id", (req: Request<{ id: string }>, res: Response) => {
  const rec = getTraffic(Number(req.params.id));
  if (!rec) {
    notFound(res, "TRAFFIC_NOT_FOUND", "Traffic record not found");
    return;
  }
  res.status(200).json(rec);
});

trafficRoutes.post(
  "/traffic/:id/replay",
  requireOperator,
  async (req: Request<{ id: string }>, res: Response) => {
    const rec = getTraffic(Number(req.params.id));
    if (!rec) {
      notFound(res, "TRAFFIC_NOT_FOUND", "Traffic record not found");
      return;
    }
    if (rec.clientName && !ensureClientAccess(req, res, rec.clientName)) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rec.argsJson) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const result = await proxyToolCall(rec.mcpToolName, args);
    recordAudit(actorFromRequest(req), "traffic.replay", rec.mcpToolName, { id: rec.id });
    res.status(200).json(result);
  },
);
