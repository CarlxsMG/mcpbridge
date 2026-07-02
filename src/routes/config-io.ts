import type { Request, Response, Express } from "express";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { exportConfig, importConfig } from "../config-io.js";
import { createSnapshot, listSnapshots, getSnapshot, deleteSnapshot, diffSnapshot, rollbackToSnapshot } from "../config-versions.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

export function configIoRoutes(app: Express): void {
  app.get("/admin-api/config/export", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    recordAudit(actorFromRequest(req), "config.export", "config");
    const doc = exportConfig();
    if (req.query.format === "yaml") {
      res.status(200).type("application/yaml").send(stringifyYaml(doc));
      return;
    }
    res.status(200).json(doc);
  });

  app.post("/admin-api/config/import", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const dryRun = body.dryRun === true;
    // Accept { dryRun, data }, a bare export document, or { format:"yaml", raw }
    // (YAML text travels inside the normal JSON body — no separate content-type
    // parser needed for a policy document this size).
    let data: unknown;
    if (body.format === "yaml" && typeof body.raw === "string") {
      try {
        data = parseYaml(body.raw);
      } catch (err) {
        res.status(400).json({ error: { code: "IMPORT_ERROR", message: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`, request_id: requestId(res) } });
        return;
      }
    } else {
      data = body.data !== undefined ? body.data : body;
    }
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

  // ── Versioned snapshots ───────────────────────────────────────────────────

  app.get("/admin-api/config/snapshots", adminAuth, requireAdminRole, (_req: Request, res: Response) => {
    res.status(200).json({ items: listSnapshots() });
  });

  app.post("/admin-api/config/snapshots", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 120) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "label is required (<= 120 chars)", request_id: requestId(res) } });
      return;
    }
    const actor = actorFromRequest(req);
    const snap = createSnapshot(label, actor);
    recordAudit(actor, "config.snapshot.create", `snapshot:${snap.id}`, { label });
    res.status(201).json(snap);
  });

  app.get("/admin-api/config/snapshots/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const snap = getSnapshot(Number(req.params.id));
    if (!snap) {
      res.status(404).json({ error: { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(snap);
  });

  app.delete("/admin-api/config/snapshots/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteSnapshot(Number(req.params.id));
    if (!ok) {
      res.status(404).json({ error: { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "config.snapshot.delete", `snapshot:${req.params.id}`);
    res.status(200).json({ status: "deleted", id: Number(req.params.id) });
  });

  app.get("/admin-api/config/snapshots/:id/diff", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const againstRaw = typeof req.query.against === "string" ? req.query.against : "current";
    const against: number | "current" = againstRaw === "current" ? "current" : Number(againstRaw);
    if (against !== "current" && !Number.isInteger(against)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "against must be 'current' or a snapshot id", request_id: requestId(res) } });
      return;
    }
    const result = diffSnapshot(Number(req.params.id), against);
    if (!result) {
      res.status(404).json({ error: { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(result);
  });

  app.post("/admin-api/config/snapshots/:id/rollback", adminAuth, requireAdminRole, async (req: Request<{ id: string }>, res: Response) => {
    const actor = actorFromRequest(req);
    const result = await rollbackToSnapshot(Number(req.params.id), actor);
    if (!result) {
      res.status(404).json({ error: { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actor, "config.snapshot.rollback", `snapshot:${req.params.id}`, { applied: result.applied, skipped: result.skipped.length });
    res.status(200).json(result);
  });
}
