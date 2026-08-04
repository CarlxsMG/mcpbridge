import { Router, type Request, type Response } from "express";
import { requireAdminRole } from "../../middleware/authz.js";
import { evaluateSecurityPosture } from "../../security/security-posture.js";

/**
 * GET /security-posture — the instance's open security conditions.
 *
 * Admin-only (`requireAdminRole`): it enumerates which protections are off,
 * which is both sensitive and only actionable by someone who can change the
 * environment. Bearer callers pass, same as everywhere else.
 *
 * Reads config and in-memory state only — no DB, no probes — so the admin UI
 * can call it on navigation without thinking about cost. See
 * src/security/security-posture.ts for what is (and is not) reported.
 */
export const securityPostureRoutes = Router();

securityPostureRoutes.get("/security-posture", requireAdminRole, (_req: Request, res: Response) => {
  res.status(200).json(evaluateSecurityPosture());
});
