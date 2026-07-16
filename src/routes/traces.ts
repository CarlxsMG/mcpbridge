import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, callerTeamId } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { listTraces, getTrace, purgeAllSpans, getTopSessions } from "../observability/trace-store.js";
import { notFound } from "./http-errors.js";

export function tracesRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  // Tenancy: `mcp_tool_name` is always a `clientName__toolName` composite key
  // (every span comes from proxyToolCall's single startSpan call site), so
  // traces/spans/top-sessions are scoped to the caller's own team's clients —
  // a team-scoped admin must not see (or purge) another tenant's tool-call
  // history. Super-admin/bearer callers (callerTeamId undefined/null) are
  // unrestricted, same convention as GET /clients.

  r.get("/traces", (req: Request, res: Response) => {
    const mcpToolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const teamId = callerTeamId(req);
    res
      .status(200)
      .json(
        listTraces({ mcpToolName, sessionId, cursor, limit, teamId: typeof teamId === "number" ? teamId : undefined }),
      );
  });

  // "Which sessions are generating the most calls" summary — powers the
  // trace-viewer's top-sessions chart.
  r.get("/traces/top-sessions", (req: Request, res: Response) => {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const teamId = callerTeamId(req);
    res.status(200).json({ items: getTopSessions(limit, typeof teamId === "number" ? teamId : undefined) });
  });

  r.get("/traces/:traceId", (req: Request<{ traceId: string }>, res: Response) => {
    const teamId = callerTeamId(req);
    const spans = getTrace(req.params.traceId, typeof teamId === "number" ? teamId : undefined);
    if (spans.length === 0) {
      notFound(res, "TRACE_NOT_FOUND", "Trace not found");
      return;
    }
    res.status(200).json({ traceId: req.params.traceId, spans });
  });

  r.delete("/traces", requireAdminRole, (req: Request, res: Response) => {
    const teamId = callerTeamId(req);
    const removed = purgeAllSpans(typeof teamId === "number" ? teamId : undefined);
    recordAudit(actorFromRequest(req), "traces.purge", "traces", { removed });
    res.status(200).json({ status: "purged", removed });
  });

  app.use("/admin-api", r);
}
