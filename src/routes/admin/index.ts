import { Router } from "express";
import type { Express } from "express";
import { adminAuth } from "../../middleware/auth.js";
import { connectRoutes } from "./connect.js";
import { overviewRoutes } from "./overview.js";
import { usersRoutes } from "./users.js";
import { auditLogRoutes } from "./audit-log.js";
import { approvalsRoutes } from "./approvals.js";
import { trafficRoutes } from "./traffic.js";
import { monitorsRoutes } from "./monitors.js";
import { oauthRoutes } from "./oauth.js";
import { canaryRoutes } from "./canary.js";
import { lbRoutes } from "./lb.js";
import { clientsRoutes } from "./clients.js";
import { toolsRoutes } from "./tools.js";

/**
 * Top-level admin router. Mounts every per-entity sub-router under
 * `/admin-api` and threads the shared `adminAuth` middleware in one place,
 * so individual sub-routers don't repeat the auth guard on every handler.
 *
 * Sub-routers write their own paths RELATIVE TO `/admin-api` (e.g. a router
 * calling `r.get("/overview", ...)` ends up at `GET /admin-api/overview`).
 *
 * Each per-entity router (clients / bundles / approvals / users / …) lives in
 * its own file in this directory. Adding a new entity means adding one file
 * and one `mount + r.use` line here — not editing a 1200-line monolith.
 */
export function adminRoutes(app: Express): void {
  const r = Router();

  // Shared admin-authentication gate. Sub-routers mounted below all inherit
  // this check; individual handlers can layer on `requireOperator` /
  // `requireAdminRole` for write/elevated operations.
  r.use(adminAuth);

  r.use(connectRoutes);
  r.use(overviewRoutes);
  r.use(usersRoutes);
  r.use(auditLogRoutes);
  r.use(approvalsRoutes);
  r.use(trafficRoutes);
  r.use(monitorsRoutes);
  r.use(oauthRoutes);
  r.use(canaryRoutes);
  r.use(lbRoutes);
  r.use(clientsRoutes);
  r.use(toolsRoutes);

  app.use("/admin-api", r);
}
