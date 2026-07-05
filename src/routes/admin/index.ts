import { Router } from "express";
import type { Express } from "express";
import { adminAuth } from "../../middleware/auth.js";
import { connectRoutes } from "./connect.js";
import { overviewRoutes } from "./overview.js";
import { usersRoutes } from "./users.js";
import { auditLogRoutes } from "./audit-log.js";
import { approvalsRoutes } from "./approvals.js";
import { mountLegacy } from "./legacyMount.js";

/**
 * Top-level admin router. Mounts every per-entity sub-router under
 * `/admin-api` and threads the shared `adminAuth` middleware in one place,
 * so individual sub-routers don't repeat the auth guard on every handler.
 *
 * Sub-routers write their own paths RELATIVE to `/admin-api` (e.g. a router
 * calling `r.get("/overview", ...)` ends up at `GET /admin-api/overview`).
 *
 * Each per-entity router (clients / bundles / approvals / users / …) lives in
 * its own file in this directory. Adding a new entity means adding one file
 * and one `mount + r.use` line here — not editing a 1200-line monolith.
 *
 * Until individual per-entity routers replace it, `legacyMount` covers the
 * not-yet-migrated routes (clients, users, audit-log, etc.) so the transition
 * is incremental and bisectable. Legacy never re-adds `adminAuth` because the
 * parent router already enforces it before reaching the legacy router.
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
  mountLegacy(r);

  app.use("/admin-api", r);
}
