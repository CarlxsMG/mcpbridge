import type { Request, Response, Express } from "express";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { exportConfig, importConfig } from "../admin/config/config-io.js";
import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  diffSnapshot,
  rollbackToSnapshot,
} from "../admin/config/config-versions.js";
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";

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
    const body = bodyOf(req);
    const dryRun = body.dryRun === true;
    // Accept { dryRun, data }, a bare export document, or { format:"yaml", raw }
    // (YAML text travels inside the normal JSON body — no separate content-type
    // parser needed for a policy document this size).
    let data: unknown;
    if (body.format === "yaml" && typeof body.raw === "string") {
      try {
        data = parseYaml(body.raw);
      } catch (err) {
        sendError(res, 400, "IMPORT_ERROR", `invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      data = body.data !== undefined ? body.data : body;
    }
    try {
      const result = await importConfig(data, { dryRun }, actorFromRequest(req));
      if (!dryRun) {
        recordAudit(actorFromRequest(req), "config.import", "config", {
          applied: result.applied,
          skipped: result.skipped.length,
        });
      }
      res.status(200).json(result);
    } catch (err) {
      sendError(res, 400, "IMPORT_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  // ── Versioned snapshots ───────────────────────────────────────────────────

  app.get("/admin-api/config/snapshots", adminAuth, requireAdminRole, (_req: Request, res: Response) => {
    res.status(200).json({ items: listSnapshots() });
  });

  app.post("/admin-api/config/snapshots", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = bodyOf(req);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 120) {
      validationError(res, "label is required (<= 120 chars)");
      return;
    }
    const actor = actorFromRequest(req);
    const snap = createSnapshot(label, actor);
    recordAudit(actor, "config.snapshot.create", `snapshot:${snap.id}`, { label });
    res.status(201).json(snap);
  });

  app.get(
    "/admin-api/config/snapshots/:id",
    adminAuth,
    requireAdminRole,
    (req: Request<{ id: string }>, res: Response) => {
      const snap = getSnapshot(Number(req.params.id));
      if (!snap) {
        notFound(res, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
        return;
      }
      res.status(200).json(snap);
    },
  );

  app.delete(
    "/admin-api/config/snapshots/:id",
    adminAuth,
    requireAdminRole,
    (req: Request<{ id: string }>, res: Response) => {
      const ok = deleteSnapshot(Number(req.params.id));
      if (!ok) {
        notFound(res, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
        return;
      }
      recordAudit(actorFromRequest(req), "config.snapshot.delete", `snapshot:${req.params.id}`);
      res.status(200).json({ status: "deleted", id: Number(req.params.id) });
    },
  );

  app.get(
    "/admin-api/config/snapshots/:id/diff",
    adminAuth,
    requireAdminRole,
    (req: Request<{ id: string }>, res: Response) => {
      const againstRaw = typeof req.query.against === "string" ? req.query.against : "current";
      const against: number | "current" = againstRaw === "current" ? "current" : Number(againstRaw);
      if (against !== "current" && !Number.isInteger(against)) {
        validationError(res, "against must be 'current' or a snapshot id");
        return;
      }
      const result = diffSnapshot(Number(req.params.id), against);
      if (!result) {
        notFound(res, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
        return;
      }
      res.status(200).json(result);
    },
  );

  app.post(
    "/admin-api/config/snapshots/:id/rollback",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ id: string }>, res: Response) => {
      const actor = actorFromRequest(req);
      const result = await rollbackToSnapshot(Number(req.params.id), actor);
      if (!result) {
        notFound(res, "SNAPSHOT_NOT_FOUND", "Snapshot not found");
        return;
      }
      recordAudit(actor, "config.snapshot.rollback", `snapshot:${req.params.id}`, {
        applied: result.applied,
        skipped: result.skipped.length,
      });
      res.status(200).json(result);
    },
  );
}
