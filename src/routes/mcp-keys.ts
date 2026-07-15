import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, isSuperAdminCaller, callerTeamId } from "../middleware/authz.js";
import { getClientTeam } from "../admin/entities/teams.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listMcpKeys,
  getMcpKey,
  createMcpKey,
  updateMcpKey,
  revokeMcpKey,
  deleteMcpKey,
  type McpKeyScopes,
} from "../security/mcp-key-store.js";
import { isAdminRole, type AdminRole } from "../security/user-store.js";
import { getConsumer } from "../admin/entities/consumers.js";
import { sendError, validationError, notFound, forbidden, bodyOf } from "./http-errors.js";
import type { ValidationResult } from "./validation.js";
import { validateExpiresAt } from "./admin-validators.js";

function validateConsumerId(v: unknown): ValidationResult<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isInteger(v))
    return { ok: false, message: "consumerId must be an integer or null" };
  if (!getConsumer(v)) return { ok: false, message: "consumerId does not reference an existing consumer" };
  return { ok: true, value: v };
}

function validateScopes(input: unknown): ValidationResult<McpKeyScopes | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "scopes must be an object or null" };
  }
  const s = input as Record<string, unknown>;
  const value: McpKeyScopes = {};
  for (const field of ["clients", "tools"] as const) {
    if (s[field] === undefined) continue;
    const arr = s[field];
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string" && x.length > 0)) {
      return { ok: false, message: `scopes.${field} must be an array of non-empty strings` };
    }
    value[field] = arr as string[];
  }
  return { ok: true, value };
}

/**
 * A data-plane key's scope is the ONLY thing confining it to a set of clients —
 * the `/mcp/:clientName` data plane itself has no team check. So a team-scoped
 * admin must not be able to mint an unrestricted (or other-team) key, which would
 * reach every tenant's tools. For a non-super-admin caller we therefore require
 * `scopes.clients` to be present, non-empty, and list only clients their team
 * owns. Super-admins (and bearer/CI callers) may mint any scope, including null.
 * Returns an error message when the scope is not permitted, or null when allowed.
 */
function scopeConfinementError(req: Request, scopes: McpKeyScopes | null): string | null {
  if (isSuperAdminCaller(req)) return null;
  const clients = scopes?.clients;
  if (!clients || clients.length === 0) {
    return "scopes.clients is required and must list only your team's clients";
  }
  const team = callerTeamId(req); // a concrete team id for a non-super-admin session
  for (const name of clients) {
    if (getClientTeam(name) !== team) {
      return `scopes.clients includes '${name}', which your team does not own`;
    }
  }
  return null;
}

function validateLabel(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0 || input.trim().length > 128) {
    return { ok: false, message: "label is required and must be 1-128 characters" };
  }
  return { ok: true, value: input.trim() };
}

/** The role this key carries on the /mcp system endpoint. Absent/null = no system access (fail-closed default). */
function validateAdminRole(input: unknown): ValidationResult<AdminRole | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (!isAdminRole(input))
    return { ok: false, message: "adminRole must be one of admin, operator, auditor, viewer, or null" };
  return { ok: true, value: input };
}

export function mcpKeyRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/mcp-keys", (_req: Request, res: Response) => {
    res.status(200).json({ items: listMcpKeys() });
  });

  r.post("/mcp-keys", requireAdminRole, (req: Request, res: Response) => {
    const body = bodyOf(req);
    const label = validateLabel(body.label);
    if (!label.ok) {
      validationError(res, label.message);
      return;
    }
    const scopes = validateScopes(body.scopes);
    if (!scopes.ok) {
      validationError(res, scopes.message);
      return;
    }
    const exp = validateExpiresAt(body.expiresAt);
    if (!exp.ok) {
      validationError(res, exp.message);
      return;
    }

    const consumer = validateConsumerId(body.consumerId);
    if (!consumer.ok) {
      validationError(res, consumer.message);
      return;
    }

    const adminRole = validateAdminRole(body.adminRole);
    if (!adminRole.ok) {
      validationError(res, adminRole.message);
      return;
    }
    // Granting system-endpoint access is equivalent to minting a new
    // globally-scoped admin credential — a team-scoped admin (who otherwise
    // only administers their own team's clients) must not be able to do that.
    if (adminRole.value !== null && !isSuperAdminCaller(req)) {
      forbidden(res, "FORBIDDEN", "Setting adminRole requires a super-admin (admin role, no team)");
      return;
    }

    const elevated = body.elevated === true;
    // `elevated` is the same step-up bypass adminRole depends on (it skips
    // the sensitive-tool __confirm gate for both backend tools in
    // proxy.ts and system tools in mcp/system-tools.ts) — granting it is
    // just as much a privilege escalation as adminRole and gets the same bar.
    if (elevated && !isSuperAdminCaller(req)) {
      forbidden(res, "FORBIDDEN", "Setting elevated requires a super-admin (admin role, no team)");
      return;
    }

    // Confine a team-scoped admin's key to its own team's clients. Runs after the
    // adminRole/elevated gates so those more-specific escalation attempts keep
    // their own error; a team admin with clean role/elevated but a missing or
    // foreign scope is rejected here.
    const scopeErr = scopeConfinementError(req, scopes.value);
    if (scopeErr) {
      forbidden(res, "FORBIDDEN", scopeErr);
      return;
    }

    const actor = actorFromRequest(req);
    const { record, rawKey } = createMcpKey(
      label.value,
      scopes.value,
      exp.value,
      actor,
      consumer.value,
      elevated,
      adminRole.value,
    );
    recordAudit(actor, "mcp_key.create", String(record.id), {
      label: label.value,
      scopes: scopes.value ?? undefined,
      consumerId: consumer.value ?? undefined,
      adminRole: adminRole.value ?? undefined,
    });
    // The raw key is returned exactly once, here — it is never persisted or retrievable again.
    res.status(201).json({ ...record, key: rawKey });
  });

  r.get("/mcp-keys/:id", (req: Request<{ id: string }>, res: Response) => {
    const rec = getMcpKey(Number(req.params.id));
    if (!rec) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    res.status(200).json(rec);
  });

  r.patch("/mcp-keys/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getMcpKey(id);
    if (!existing) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    const body = bodyOf(req);
    const updates: {
      label?: string;
      enabled?: boolean;
      expiresAt?: number | null;
      scopes?: McpKeyScopes | null;
      consumerId?: number | null;
      elevated?: boolean;
      adminRole?: AdminRole | null;
    } = {};

    if (body.label !== undefined) {
      const label = validateLabel(body.label);
      if (!label.ok) {
        validationError(res, label.message);
        return;
      }
      updates.label = label.value;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        validationError(res, "enabled must be a boolean");
        return;
      }
      updates.enabled = body.enabled;
    }
    if (body.expiresAt !== undefined) {
      const exp = validateExpiresAt(body.expiresAt);
      if (!exp.ok) {
        validationError(res, exp.message);
        return;
      }
      updates.expiresAt = exp.value;
    }
    if (body.scopes !== undefined) {
      const scopes = validateScopes(body.scopes);
      if (!scopes.ok) {
        validationError(res, scopes.message);
        return;
      }
      // Same confinement as create: a team-scoped admin can't re-scope a key
      // beyond its own team's clients.
      const scopeErr = scopeConfinementError(req, scopes.value);
      if (scopeErr) {
        forbidden(res, "FORBIDDEN", scopeErr);
        return;
      }
      updates.scopes = scopes.value;
    }
    if (body.consumerId !== undefined) {
      const consumer = validateConsumerId(body.consumerId);
      if (!consumer.ok) {
        validationError(res, consumer.message);
        return;
      }
      updates.consumerId = consumer.value;
    }
    if (body.elevated !== undefined) {
      if (typeof body.elevated !== "boolean") {
        validationError(res, "elevated must be a boolean");
        return;
      }
      // Same super-admin bar as adminRole: elevated skips the sensitive-tool
      // __confirm gate for both backend tools (proxy.ts) and system tools
      // (mcp/system-tools.ts) on THIS key, whoever holds it and whatever
      // team issued it — a team-scoped admin must not be able to grant that
      // to a key it doesn't otherwise control any more than it could via
      // adminRole.
      if (body.elevated && !isSuperAdminCaller(req)) {
        forbidden(res, "FORBIDDEN", "Setting elevated requires a super-admin (admin role, no team)");
        return;
      }
      updates.elevated = body.elevated;
    }
    if (body.adminRole !== undefined) {
      const adminRole = validateAdminRole(body.adminRole);
      if (!adminRole.ok) {
        validationError(res, adminRole.message);
        return;
      }
      // Same super-admin bar as create: this field is the only way to grant
      // (or change) control-plane access on an existing key.
      if (adminRole.value !== null && !isSuperAdminCaller(req)) {
        forbidden(res, "FORBIDDEN", "Setting adminRole requires a super-admin (admin role, no team)");
        return;
      }
      updates.adminRole = adminRole.value;
    }

    const rec = updateMcpKey(id, updates);
    recordAudit(actorFromRequest(req), "mcp_key.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(rec);
  });

  r.post("/mcp-keys/:id/revoke", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    if (!getMcpKey(id)) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    const ok = revokeMcpKey(id);
    if (!ok) {
      sendError(res, 409, "ALREADY_REVOKED", "API key is already revoked");
      return;
    }
    recordAudit(actorFromRequest(req), "mcp_key.revoke", String(id));
    res.status(200).json({ status: "revoked", id });
  });

  r.delete("/mcp-keys/:id", requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const ok = deleteMcpKey(id);
    if (!ok) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    recordAudit(actorFromRequest(req), "mcp_key.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });

  app.use("/admin-api", r);
}
