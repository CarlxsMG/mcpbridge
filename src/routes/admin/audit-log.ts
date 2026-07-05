import { Router, type Request, type Response } from "express";
import {
  listAuditLog,
  exportAuditLog,
  verifyAuditChain,
  listAuditActions,
} from "../../admin/audit/audit.js";
import { auditLogToCsv, auditLogToHtml } from "../../admin/audit/audit-export.js";

/**
 * Audit-log read endpoints (4): list (paginated, filtered), verify
 * (chain integrity), actions (distinct action values for the admin UI's
 * filter dropdown), and export (CSV / HTML / JSON download).
 *
 * Mutations DO NOT live here — audit records are written by every other
 * admin handler via recordAudit(...) and never by a dedicated endpoint.
 */
export const auditLogRoutes = Router();

auditLogRoutes.get("/audit-log", (req: Request, res: Response) => {
  const { actor, action, from, to, cursor, limit } = req.query;
  const result = listAuditLog({
    actor: typeof actor === "string" ? actor : undefined,
    action: typeof action === "string" ? action : undefined,
    from: typeof from === "string" ? Number(from) : undefined,
    to: typeof to === "string" ? Number(to) : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
  });
  res.status(200).json(result);
});

auditLogRoutes.get("/audit-log/verify", (_req: Request, res: Response) => {
  res.status(200).json(verifyAuditChain());
});

/** Distinct action values present in the log — backs the admin-ui action filter's <select>. */
auditLogRoutes.get("/audit-log/actions", (_req: Request, res: Response) => {
  res.status(200).json({ actions: listAuditActions() });
});

auditLogRoutes.get("/audit-log/export", (req: Request, res: Response) => {
  const { actor, action, from, to, format } = req.query;
  const filters = {
    actor: typeof actor === "string" ? actor : undefined,
    action: typeof action === "string" ? action : undefined,
    from: typeof from === "string" ? Number(from) : undefined,
    to: typeof to === "string" ? Number(to) : undefined,
  };
  const items = exportAuditLog(filters);

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
