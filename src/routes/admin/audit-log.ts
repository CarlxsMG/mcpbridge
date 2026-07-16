import { Router, type Request, type Response } from "express";
import { listAuditLog, exportAuditLog, verifyAuditChain, listAuditActions } from "../../admin/audit/audit.js";
import { auditLogToCsv, auditLogToHtml } from "../../admin/audit/audit-export.js";
import { requireOperator, callerTeamId } from "../../middleware/authz.js";

/**
 * Audit-log read endpoints (4): list (paginated, filtered), verify
 * (chain integrity), actions (distinct action values for the admin UI's
 * filter dropdown), and export (CSV / HTML / JSON download).
 *
 * Mutations DO NOT live here — audit records are written by every other
 * admin handler via recordAudit(...) and never by a dedicated endpoint.
 *
 * List/export/verify require operator+ (matching traffic.ts's rationale: a
 * captured audit record's `detail_json` can carry the same kind of sensitive
 * payload data traffic records do, so the lowest viewer/auditor tiers must
 * not read it). List/export additionally scope to the caller's team — see
 * listAuditLog/exportAuditLog's teamId doc comment for exactly what that
 * scoping does (and doesn't) recognize.
 */
export const auditLogRoutes = Router();

auditLogRoutes.get("/audit-log", requireOperator, (req: Request, res: Response) => {
  const { actor, action, from, to, cursor, limit } = req.query;
  const teamId = callerTeamId(req);
  const result = listAuditLog({
    actor: typeof actor === "string" ? actor : undefined,
    action: typeof action === "string" ? action : undefined,
    from: typeof from === "string" ? Number(from) : undefined,
    to: typeof to === "string" ? Number(to) : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
    teamId: typeof teamId === "number" ? teamId : undefined,
  });
  res.status(200).json(result);
});

auditLogRoutes.get("/audit-log/verify", requireOperator, (_req: Request, res: Response) => {
  res.status(200).json(verifyAuditChain());
});

/** Distinct action values present in the log — backs the admin-ui action filter's <select>. */
auditLogRoutes.get("/audit-log/actions", (_req: Request, res: Response) => {
  res.status(200).json({ actions: listAuditActions() });
});

auditLogRoutes.get("/audit-log/export", requireOperator, (req: Request, res: Response) => {
  const { actor, action, from, to, format } = req.query;
  const teamId = callerTeamId(req);
  // Filters as displayed/reported to the caller (the export's public shape —
  // teamId is an internal scoping detail, not a user-facing filter, so it's
  // kept out of this object and passed to exportAuditLog separately below).
  const filters = {
    actor: typeof actor === "string" ? actor : undefined,
    action: typeof action === "string" ? action : undefined,
    from: typeof from === "string" ? Number(from) : undefined,
    to: typeof to === "string" ? Number(to) : undefined,
  };
  const items = exportAuditLog({ ...filters, teamId: typeof teamId === "number" ? teamId : undefined });

  // Filtering/row-cap logic lives entirely in exportAuditLog above — `format`
  // only changes how those same rows are serialized here at the route layer.
  if (format === "csv") {
    res
      .status(200)
      .type("text/csv")
      .setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"')
      .send(auditLogToCsv(items));
    return;
  }
  if (format === "html") {
    const html = auditLogToHtml(items, { ...filters, generatedAt: Date.now(), chain: verifyAuditChain() });
    res
      .status(200)
      .type("text/html")
      .setHeader("Content-Disposition", 'attachment; filename="audit-log.html"')
      .send(html);
    return;
  }
  // format=json (or omitted/unrecognized) — unchanged existing behavior.
  res.status(200).json({ items, count: items.length });
});
