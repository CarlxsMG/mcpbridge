import { Router, type Request, type Response } from "express";
import { listMonitors } from "../../observability/monitor.js";

/**
 * Synthetic monitor list: snapshot of every per-tool synthetic check the
 * bridge is running (drift detection, periodic liveness, etc.). The monitor
 * lifecycle — create / update / delete / pause — is configured per-tool through
 * the `monitor` key of the per-tool policy PATCH in `tools.ts` (handled by
 * `admin/tool-policies/mutations/monitor.ts`), so this router exposes only the
 * dashboard read.
 */
export const monitorsRoutes = Router();

monitorsRoutes.get("/monitors", (_req: Request, res: Response) => {
  res.status(200).json({ items: listMonitors() });
});
