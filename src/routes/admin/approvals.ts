import { Router, type Request, type Response } from "express";
import {
  listApprovals,
  getApproval,
  decideApproval,
  type ApprovalStatus,
} from "../../admin/entities/approvals.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import { sendError, notFound } from "../http-errors.js";
import { ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import { TOOL_KEY_SEPARATOR, toolKey } from "../../lib/identifier.js";

/**
 * Human-in-the-loop approvals queue: list pending tickets, decide one
 * (approve / reject). The queue itself is populated by the proxy whenever
 * a tool call is queued for approval (per-tool `setApprovalRequired`) or
 * escalated by auto-quarantine; this router only exposes the dashboard
 * + decision surface, never the act of queueing itself.
 */
export const approvalsRoutes = Router();

approvalsRoutes.get("/approvals", (req: Request, res: Response) => {
  const q = req.query.status;
  const status: ApprovalStatus | undefined = q === "pending" || q === "approved" || q === "rejected" ? q : undefined;
  res.status(200).json({ items: listApprovals(status) });
});

approvalsRoutes.post(
  "/approvals/:id/approve",
  requireOperator,
  (req: Request<{ id: string }>, res: Response) => {
    const rec = getApproval(Number(req.params.id));
    if (!rec) {
      notFound(res, "APPROVAL_NOT_FOUND", "Approval not found");
      return;
    }
    if (!ensureClientAccess(req, res, rec.clientName)) return;
    const note =
      typeof (req.body as Record<string, unknown>)?.note === "string"
        ? ((req.body as Record<string, unknown>).note as string)
        : null;
    const result = decideApproval(rec.id, "approved", actorFromRequest(req), note);
    if (!result.ok) {
      sendError(res, 409, "NOT_PENDING", result.message);
      return;
    }
    recordAudit(actorFromRequest(req), "approval.approve", toolKey(rec.clientName, rec.toolName), {
      id: rec.id,
      finalStatus: result.finalStatus,
      approvalsReceived: result.approvalsReceived,
      requiredLevels: result.requiredLevels,
    });
    res.status(200).json({
      status: result.finalStatus,
      id: rec.id,
      approvalsReceived: result.approvalsReceived,
      requiredLevels: result.requiredLevels,
    });
  },
);

approvalsRoutes.post(
  "/approvals/:id/reject",
  requireOperator,
  (req: Request<{ id: string }>, res: Response) => {
    const rec = getApproval(Number(req.params.id));
    if (!rec) {
      notFound(res, "APPROVAL_NOT_FOUND", "Approval not found");
      return;
    }
    if (!ensureClientAccess(req, res, rec.clientName)) return;
    const note =
      typeof (req.body as Record<string, unknown>)?.note === "string"
        ? ((req.body as Record<string, unknown>).note as string)
        : null;
    const result = decideApproval(rec.id, "rejected", actorFromRequest(req), note);
    if (!result.ok) {
      sendError(res, 409, "NOT_PENDING", result.message);
      return;
    }
    recordAudit(actorFromRequest(req), "approval.reject", toolKey(rec.clientName, rec.toolName), {
      id: rec.id,
    });
    res.status(200).json({ status: result.finalStatus, id: rec.id });
  },
);
