import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
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
import { getConsumer } from "../admin/entities/consumers.js";
import { sendError, validationError, notFound } from "./http-errors.js";

function validateConsumerId(v: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isInteger(v))
    return { ok: false, message: "consumerId must be an integer or null" };
  if (!getConsumer(v)) return { ok: false, message: "consumerId does not reference an existing consumer" };
  return { ok: true, value: v };
}

function validateScopes(input: unknown): { ok: true; value: McpKeyScopes | null } | { ok: false; message: string } {
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

function validateExpiresAt(input: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return { ok: false, message: "expiresAt must be a positive epoch-ms number or null" };
  }
  return { ok: true, value: input };
}

function validateLabel(input: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof input !== "string" || input.trim().length === 0 || input.trim().length > 128) {
    return { ok: false, message: "label is required and must be 1-128 characters" };
  }
  return { ok: true, value: input.trim() };
}

export function mcpKeyRoutes(app: Express): void {
  app.get("/admin-api/mcp-keys", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listMcpKeys() });
  });

  app.post("/admin-api/mcp-keys", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
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

    const actor = actorFromRequest(req);
    const elevated = body.elevated === true;
    const { record, rawKey } = createMcpKey(label.value, scopes.value, exp.value, actor, consumer.value, elevated);
    recordAudit(actor, "mcp_key.create", String(record.id), {
      label: label.value,
      scopes: scopes.value ?? undefined,
      consumerId: consumer.value ?? undefined,
    });
    // The raw key is returned exactly once, here — it is never persisted or retrievable again.
    res.status(201).json({ ...record, key: rawKey });
  });

  app.get("/admin-api/mcp-keys/:id", adminAuth, (req: Request<{ id: string }>, res: Response) => {
    const rec = getMcpKey(Number(req.params.id));
    if (!rec) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    res.status(200).json(rec);
  });

  app.patch("/admin-api/mcp-keys/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const existing = getMcpKey(id);
    if (!existing) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: {
      label?: string;
      enabled?: boolean;
      expiresAt?: number | null;
      scopes?: McpKeyScopes | null;
      consumerId?: number | null;
      elevated?: boolean;
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
      updates.elevated = body.elevated;
    }

    const rec = updateMcpKey(id, updates);
    recordAudit(actorFromRequest(req), "mcp_key.update", String(id), { fields: Object.keys(updates) });
    res.status(200).json(rec);
  });

  app.post(
    "/admin-api/mcp-keys/:id/revoke",
    adminAuth,
    requireAdminRole,
    (req: Request<{ id: string }>, res: Response) => {
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
    },
  );

  app.delete("/admin-api/mcp-keys/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
    const id = Number(req.params.id);
    const ok = deleteMcpKey(id);
    if (!ok) {
      notFound(res, "MCP_KEY_NOT_FOUND", "API key not found");
      return;
    }
    recordAudit(actorFromRequest(req), "mcp_key.delete", String(id));
    res.status(200).json({ status: "deleted", id });
  });
}
