import { Router, type Request, type Response } from "express";
import { registry } from "../../mcp/registry.js";
import { ensureClientAccess, callerTeamId, requireOperator, canCallerAccessClient } from "../../middleware/authz.js";
import { validationError, notFound, bodyOf } from "../http-errors.js";
import { validateClientGuardInput } from "../admin-validators.js";
import { actorFromRequest, recordAudit } from "../../admin/audit/audit.js";
import type { ClientStatus } from "../../mcp/types.js";

/**
 * Clients CRUD-ish surface. Per-client PATCH exposes two sub-mutations in one
 * body (enabled toggle + guards update) — kept inline because splitting it
 * would turn one endpoint into a body-shape dispatch, more refactor than
 * clean-cut. (The per-tool policy PATCH, whose body carried far more keys, did
 * get that treatment: it lives in `tools.ts`, delegating each body key to its
 * own mutation under `admin/tool-policies/mutations/`.)
 *
 * Auth: any admin can list / view (team-scoped). Mutations (PATCH, DELETE,
 * bulk-PATCH) require the operator role.
 */
export const clientsRoutes = Router();

// ── Listing / detail (admin auth inherited from parent router) ──────────────

clientsRoutes.get("/clients", (req: Request, res: Response) => {
  const { q, status, enabled, cursor, limit } = req.query;
  const teamId = callerTeamId(req);
  const result = registry.listClientsSummary({
    q: typeof q === "string" ? q : undefined,
    status: typeof status === "string" ? (status as ClientStatus) : undefined,
    enabled: enabled === "true" ? true : enabled === "false" ? false : undefined,
    cursor: typeof cursor === "string" ? cursor : undefined,
    limit: typeof limit === "string" ? Number(limit) : undefined,
    // Scope the listing for team users; super-admins (null/undefined) see all.
    teamId: typeof teamId === "number" ? teamId : undefined,
  });
  res.status(200).json(result);
});

clientsRoutes.get("/clients/:name", (req: Request<{ name: string }>, res: Response) => {
  if (!ensureClientAccess(req, res, req.params.name)) return;
  const detail = registry.getClientDetail(req.params.name);
  if (!detail) {
    notFound(res, "CLIENT_NOT_FOUND", "Client not found");
    return;
  }
  res.status(200).json(detail);
});

// ── Per-client mutations (operator-tier) ─────────────────────────────────────

clientsRoutes.patch("/clients/:name", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const body = bodyOf(req);
  const actor = actorFromRequest(req);

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      validationError(res, "enabled must be a boolean");
      return;
    }
    const ok = await registry.setClientEnabled(name, body.enabled);
    if (!ok) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    recordAudit(actor, body.enabled ? "client.enable" : "client.disable", name);
  }

  if (body.guards !== undefined) {
    const parsed = validateClientGuardInput(body.guards);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const ok = await registry.setClientGuards(name, parsed.value);
    if (!ok) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    recordAudit(actor, "client.guards.update", name, { guards: parsed.value });
  }

  res.status(200).json({ status: "updated", name });
});

clientsRoutes.delete("/clients/:name", requireOperator, async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  if (!ensureClientAccess(req, res, name)) return;
  const actor = actorFromRequest(req);
  const removed = await registry.forgetClient(name);
  if (!removed) {
    notFound(res, "CLIENT_NOT_FOUND", "Client not found");
    return;
  }
  recordAudit(actor, "client.delete", name);
  res.status(200).json({ status: "deleted", name });
});

// Bulk enable/disable across a list of client names. Single endpoint,
// one transaction per name — partial successes are reported in the
// response so the operator can see which names didn't exist.
clientsRoutes.patch("/clients", requireOperator, async (req: Request, res: Response) => {
  const body = bodyOf(req);
  const names = body.names;
  const enabled = body.enabled;
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string") || typeof enabled !== "boolean") {
    validationError(res, "names (string[]) and enabled (boolean) are required");
    return;
  }
  const actor = actorFromRequest(req);
  const results: Record<string, boolean> = {};
  for (const name of names as string[]) {
    // Tenancy: a team-scoped caller can't toggle clients outside its team —
    // report them as not-found (false), the same way ensureClientAccess hides
    // a single out-of-team client behind a 404.
    if (!canCallerAccessClient(req, name)) {
      results[name] = false;
      continue;
    }
    results[name] = await registry.setClientEnabled(name, enabled);
    if (results[name]) recordAudit(actor, enabled ? "client.enable" : "client.disable", name, { bulk: true });
  }
  res.status(200).json({ results });
});
