import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { exportConfig, importConfig } from "../config-io.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

export function configIoRoutes(app: Express): void {
  app.get("/admin-api/config/export", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    recordAudit(actorFromRequest(req), "config.export", "config");
    res.status(200).json(exportConfig());
  });

  app.post("/admin-api/config/import", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const dryRun = body.dryRun === true;
    // Accept either { dryRun, data } or a bare export document.
    const data = body.data !== undefined ? body.data : body;
    try {
      const result = await importConfig(data, { dryRun }, actorFromRequest(req));
      if (!dryRun) {
        recordAudit(actorFromRequest(req), "config.import", "config", { applied: result.applied, skipped: result.skipped.length });
      }
      res.status(200).json(result);
    } catch (err) {
      res.status(400).json({ error: { code: "IMPORT_ERROR", message: err instanceof Error ? err.message : String(err), request_id: requestId(res) } });
    }
  });
}
