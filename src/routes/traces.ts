import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listTraces, getTrace, purgeAllSpans } from "../observability/trace-store.js";
import { notFound } from "./http-errors.js";

export function tracesRoutes(app: Express): void {
  app.get("/admin-api/traces", adminAuth, (req: Request, res: Response) => {
    const mcpToolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    res.status(200).json(listTraces({ mcpToolName, cursor, limit }));
  });

  app.get("/admin-api/traces/:traceId", adminAuth, (req: Request<{ traceId: string }>, res: Response) => {
    const spans = getTrace(req.params.traceId);
    if (spans.length === 0) {
      notFound(res, "TRACE_NOT_FOUND", "Trace not found");
      return;
    }
    res.status(200).json({ traceId: req.params.traceId, spans });
  });

  app.delete("/admin-api/traces", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const removed = purgeAllSpans();
    recordAudit(actorFromRequest(req), "traces.purge", "traces", { removed });
    res.status(200).json({ status: "purged", removed });
  });
}
