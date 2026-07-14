import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, ensureClientAccess } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { getDb } from "../db/connection.js";
import { isSecretBoxConfigured } from "../security/secret-box.js";
import {
  getUpstreamAuthInfo,
  setUpstreamAuth,
  clearUpstreamAuth,
  type UpstreamAuthType,
  type UpstreamSecret,
} from "../backend-auth/upstream-auth.js";
import { sendError, validationError, notFound } from "./http-errors.js";
import type { ValidationResult } from "./validation.js";

function clientExists(name: string): boolean {
  return getDb().query(`SELECT 1 FROM clients WHERE name = ?`).get(name) != null;
}

// These would either break the pinned-Host SSRF protection or the JSON body framing.
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type"]);

type ValidatedAuth = { type: UpstreamAuthType; secret: UpstreamSecret; headerName: string | null };

function validateBody(input: unknown): ValidationResult<ValidatedAuth> {
  if (typeof input !== "object" || input === null) return { ok: false, message: "body must be an object" };
  const b = input as Record<string, unknown>;
  switch (b.type) {
    case "bearer":
      if (typeof b.token !== "string" || b.token.length === 0)
        return { ok: false, message: "token is required for bearer auth" };
      return { ok: true, value: { type: "bearer", secret: { token: b.token }, headerName: null } };
    case "basic":
      if (
        typeof b.username !== "string" ||
        b.username.length === 0 ||
        typeof b.password !== "string" ||
        b.password.length === 0
      ) {
        return { ok: false, message: "username and password are required for basic auth" };
      }
      return {
        ok: true,
        value: { type: "basic", secret: { username: b.username, password: b.password }, headerName: null },
      };
    case "header": {
      if (typeof b.headerName !== "string" || b.headerName.length === 0)
        return { ok: false, message: "headerName is required for header auth" };
      if (!/^[A-Za-z0-9-]+$/.test(b.headerName))
        return { ok: false, message: "headerName must be a valid header token" };
      if (FORBIDDEN_HEADERS.has(b.headerName.toLowerCase()))
        return { ok: false, message: `headerName '${b.headerName}' is not allowed` };
      if (typeof b.value !== "string" || b.value.length === 0)
        return { ok: false, message: "value is required for header auth" };
      return { ok: true, value: { type: "header", secret: { value: b.value }, headerName: b.headerName } };
    }
    default:
      return { ok: false, message: "type must be one of: bearer, basic, header" };
  }
}

export function upstreamAuthRoutes(app: Express): void {
  app.get("/admin-api/clients/:name/upstream-auth", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    // Tenancy scope first, so a caller can't even confirm another team's client
    // exists (ensureClientAccess writes the same CLIENT_NOT_FOUND on a cross-team
    // client as on a genuinely missing one).
    if (!ensureClientAccess(req, res, req.params.name)) return;
    if (!clientExists(req.params.name)) {
      notFound(res, "CLIENT_NOT_FOUND", "Client not found");
      return;
    }
    res.status(200).json(getUpstreamAuthInfo(req.params.name));
  });

  app.put(
    "/admin-api/clients/:name/upstream-auth",
    adminAuth,
    requireAdminRole,
    (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      if (!clientExists(name)) {
        notFound(res, "CLIENT_NOT_FOUND", "Client not found");
        return;
      }
      if (!isSecretBoxConfigured()) {
        sendError(res, 501, "SECRET_BOX_NOT_CONFIGURED", "Set SECRET_ENCRYPTION_KEY to store upstream credentials");
        return;
      }
      const parsed = validateBody(req.body);
      if (!parsed.ok) {
        validationError(res, parsed.message);
        return;
      }
      setUpstreamAuth(name, parsed.value.type, parsed.value.secret, parsed.value.headerName);
      recordAudit(actorFromRequest(req), "client.upstream_auth.set", name, { type: parsed.value.type });
      res.status(200).json({ status: "updated", name, ...getUpstreamAuthInfo(name) });
    },
  );

  app.delete(
    "/admin-api/clients/:name/upstream-auth",
    adminAuth,
    requireAdminRole,
    (req: Request<{ name: string }>, res: Response) => {
      if (!ensureClientAccess(req, res, req.params.name)) return;
      const ok = clearUpstreamAuth(req.params.name);
      if (!ok) {
        notFound(res, "NOT_CONFIGURED", "No upstream auth configured for this client");
        return;
      }
      recordAudit(actorFromRequest(req), "client.upstream_auth.clear", req.params.name);
      res.status(200).json({ status: "cleared", name: req.params.name });
    },
  );
}
