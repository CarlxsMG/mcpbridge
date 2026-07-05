import { Router, type Request, type Response } from "express";
import { listMonitors } from "../../observability/monitor.js";

/**
 * Synthetic monitor list: snapshot of every per-tool synthetic check the
 * bridge is running (drift detection, periodic liveness, etc.). The
 * monitor lifecycle — create / update / delete / pause — is configured
 * per-tool via the under-the-client routes in legacyMount (now
 * slated for further split in P0-2b continuations), so this router
 * exposes only the dashboard read.
 */
export const monitorsRoutes = Router();

monitorsRoutes.get("/monitors", (_req: Request, res: Response) => {
  res.status(200).json({ items: listMonitors() });
});
