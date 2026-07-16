import { Router, type Request, type Response } from "express";
import { listMonitors } from "../../observability/monitor.js";
import { callerTeamId } from "../../middleware/authz.js";

/**
 * Synthetic monitor list: snapshot of every per-tool synthetic check the
 * bridge is running (drift detection, periodic liveness, etc.). The monitor
 * lifecycle — create / update / delete / pause — is configured per-tool through
 * the `monitor` key of the per-tool policy PATCH in `tools.ts` (handled by
 * `admin/tool-policies/mutations/monitor.ts`), so this router exposes only the
 * dashboard read.
 */
export const monitorsRoutes = Router();

monitorsRoutes.get("/monitors", (req: Request, res: Response) => {
  const teamId = callerTeamId(req);
  // Tenancy: a team-scoped caller only sees monitors for clients their team
  // owns — same scoping clients.ts/traffic.ts already apply to their lists.
  res.status(200).json({ items: listMonitors(typeof teamId === "number" ? teamId : undefined) });
});
