import { Router } from "express";
import type { Request, Response } from "express";
import { requireAdminRole, teamScope } from "../../middleware/authz.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import { listTraces, getTrace, purgeAllSpans, getTopSessions } from "../../observability/trace-store.js";
import { notFound } from "../http-errors.js";

export const tracesRoutes = Router();

// Tenancy: `mcp_tool_name` is always a `clientName__toolName` composite key
// (every span comes from proxyToolCall's single startSpan call site), so
// traces/spans/top-sessions are scoped to the caller's own team's clients —
// a team-scoped admin must not see (or purge) another tenant's tool-call
// history. Super-admin/bearer callers (callerTeamId undefined/null) are
// unrestricted, same convention as GET /clients.

tracesRoutes.get("/traces", (req: Request, res: Response) => {
  const mcpToolName = typeof req.query.tool === "string" ? req.query.tool : undefined;
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  res.status(200).json(listTraces({ mcpToolName, sessionId, cursor, limit, teamId: teamScope(req) }));
});

// "Which sessions are generating the most calls" summary — powers the
// trace-viewer's top-sessions chart.
tracesRoutes.get("/traces/top-sessions", (req: Request, res: Response) => {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  res.status(200).json({ items: getTopSessions(limit, teamScope(req)) });
});

tracesRoutes.get("/traces/:traceId", (req: Request<{ traceId: string }>, res: Response) => {
  const spans = getTrace(req.params.traceId, teamScope(req));
  if (spans.length === 0) {
    notFound(res, "TRACE_NOT_FOUND", "Trace not found");
    return;
  }
  res.status(200).json({ traceId: req.params.traceId, spans });
});

tracesRoutes.delete("/traces", requireAdminRole, (req: Request, res: Response) => {
  const removed = purgeAllSpans(teamScope(req));
  recordAudit(actorFromRequest(req), "traces.purge", "traces", { removed });
  res.status(200).json({ status: "purged", removed });
});
