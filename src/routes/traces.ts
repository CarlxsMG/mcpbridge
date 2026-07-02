import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { listTraces, getTrace, purgeAllSpans } from "../observability/trace-store.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

export function tracesRoutes(app: Express): void {
  app.get("/admin-api/traces", adminAuth, (req: Request, res: Response) => {
    const mcpToolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    res.status(200).json({ items: listTraces({ mcpToolName, limit }) });
  });

  app.get("/admin-api/traces/:traceId", adminAuth, (req: Request<{ traceId: string }>, res: Response) => {
    const spans = getTrace(req.params.traceId);
    if (spans.length === 0) {
      res.status(404).json({ error: { code: "TRACE_NOT_FOUND", message: "Trace not found", request_id: requestId(res) } });
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
