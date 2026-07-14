import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import {
  listWsProxyTargets,
  getWsProxyTargetDetail,
  upsertWsProxyTarget,
  deleteWsProxyTarget,
  disconnectAllForTarget,
  type WsProxyTargetError,
  type WsProxyTargetInput,
} from "../ws-proxy.js";
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";
import { type ValidationResult, mutationErrorToStatus } from "./validation.js";

const WS_PROXY_ERROR_STATUS: Record<WsProxyTargetError["code"], number> = {
  INVALID_NAME: 400,
  INVALID_URL: 400,
  NAME_COLLISION: 409,
};

function parseTargetInput(body: Record<string, unknown>): ValidationResult<WsProxyTargetInput> {
  if (typeof body.backendWsUrl !== "string" || !body.backendWsUrl) {
    return { ok: false, message: "backendWsUrl is required" };
  }
  const value: WsProxyTargetInput = { backendWsUrl: body.backendWsUrl };
  if (body.maxConnections !== undefined) {
    if (typeof body.maxConnections !== "number" || !Number.isInteger(body.maxConnections) || body.maxConnections < 1) {
      return { ok: false, message: "maxConnections must be a positive integer" };
    }
    value.maxConnections = body.maxConnections;
  }
  if (body.maxMessageBytes !== undefined) {
    if (
      typeof body.maxMessageBytes !== "number" ||
      !Number.isInteger(body.maxMessageBytes) ||
      body.maxMessageBytes < 1
    ) {
      return { ok: false, message: "maxMessageBytes must be a positive integer" };
    }
    value.maxMessageBytes = body.maxMessageBytes;
  }
  if (body.idleTimeoutMs !== undefined) {
    if (typeof body.idleTimeoutMs !== "number" || !Number.isInteger(body.idleTimeoutMs) || body.idleTimeoutMs < 1) {
      return { ok: false, message: "idleTimeoutMs must be a positive integer" };
    }
    value.idleTimeoutMs = body.idleTimeoutMs;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, message: "enabled must be a boolean" };
    }
    value.enabled = body.enabled;
  }
  return { ok: true, value };
}

/**
 * Admin CRUD for ws-proxy targets — a separate surface from /register since a
 * target has no tools and isn't a "server" in the tools/list sense (see
 * ws-proxy.ts's header comment for the full rationale).
 */
export function wsProxyAdminRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/ws-proxy-targets", (_req: Request, res: Response) => {
    res.status(200).json({ items: listWsProxyTargets() });
  });

  r.get("/ws-proxy-targets/:name", (req: Request<{ name: string }>, res: Response) => {
    const detail = getWsProxyTargetDetail(req.params.name);
    if (!detail) {
      notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
      return;
    }
    res.status(200).json(detail);
  });

  r.post("/ws-proxy-targets", requireAdminRole, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const name = typeof body.name === "string" ? body.name : "";
    const parsed = parseTargetInput(body);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const result = await upsertWsProxyTarget(name, parsed.value);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, WS_PROXY_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actorFromRequest(req), "ws_proxy_target.create", name, { backendWsUrl: parsed.value.backendWsUrl });
    res.status(201).json(getWsProxyTargetDetail(name));
  });

  r.patch("/ws-proxy-targets/:name", requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!getWsProxyTargetDetail(name)) {
      notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
      return;
    }
    const body = bodyOf(req);
    const existing = getWsProxyTargetDetail(name)!;
    const merged = {
      backendWsUrl: existing.backendWsUrl,
      maxConnections: existing.maxConnections,
      maxMessageBytes: existing.maxMessageBytes,
      idleTimeoutMs: existing.idleTimeoutMs,
      enabled: existing.enabled,
      ...body,
    };
    const parsed = parseTargetInput(merged);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const result = await upsertWsProxyTarget(name, parsed.value);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, WS_PROXY_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actorFromRequest(req), "ws_proxy_target.update", name, { fields: Object.keys(body) });
    res.status(200).json(getWsProxyTargetDetail(name));
  });

  r.delete("/ws-proxy-targets/:name", requireAdminRole, (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!deleteWsProxyTarget(name)) {
      notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
      return;
    }
    recordAudit(actorFromRequest(req), "ws_proxy_target.delete", name);
    res.status(200).json({ status: "deleted", name });
  });

  r.post(
    "/ws-proxy-targets/:name/disconnect-all",
    requireAdminRole,
    (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!getWsProxyTargetDetail(name)) {
        notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
        return;
      }
      const closed = disconnectAllForTarget(name);
      recordAudit(actorFromRequest(req), "ws_proxy_target.disconnect_all", name, { closed });
      res.status(200).json({ status: "disconnected", closed });
    },
  );

  app.use("/admin-api", r);
}
