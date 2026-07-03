import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import {
  listWsProxyTargets,
  getWsProxyTargetDetail,
  upsertWsProxyTarget,
  deleteWsProxyTarget,
  disconnectAllForTarget,
  type WsProxyTargetError,
  type WsProxyTargetInput,
} from "../ws-proxy.js";
import { sendError, validationError, notFound } from "./http-errors.js";

function statusForWsProxyError(code: WsProxyTargetError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "INVALID_URL":
      return 400;
    case "NAME_COLLISION":
      return 409;
  }
}

function parseTargetInput(
  body: Record<string, unknown>,
): { ok: true; value: WsProxyTargetInput } | { ok: false; message: string } {
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
  app.get("/admin-api/ws-proxy-targets", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listWsProxyTargets() });
  });

  app.get("/admin-api/ws-proxy-targets/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const detail = getWsProxyTargetDetail(req.params.name);
    if (!detail) {
      notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
      return;
    }
    res.status(200).json(detail);
  });

  app.post("/admin-api/ws-proxy-targets", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const parsed = parseTargetInput(body);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const result = await upsertWsProxyTarget(name, parsed.value);
    if (!result.ok) {
      sendError(res, statusForWsProxyError(result.error.code), result.error.code, result.error.message);
      return;
    }
    recordAudit(actorFromRequest(req), "ws_proxy_target.create", name, { backendWsUrl: parsed.value.backendWsUrl });
    res.status(201).json(getWsProxyTargetDetail(name));
  });

  app.patch(
    "/admin-api/ws-proxy-targets/:name",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!getWsProxyTargetDetail(name)) {
        notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
        return;
      }
      const body = (req.body as Record<string, unknown>) ?? {};
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
        sendError(res, statusForWsProxyError(result.error.code), result.error.code, result.error.message);
        return;
      }
      recordAudit(actorFromRequest(req), "ws_proxy_target.update", name, { fields: Object.keys(body) });
      res.status(200).json(getWsProxyTargetDetail(name));
    },
  );

  app.delete(
    "/admin-api/ws-proxy-targets/:name",
    adminAuth,
    requireAdminRole,
    (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      if (!deleteWsProxyTarget(name)) {
        notFound(res, "WS_PROXY_TARGET_NOT_FOUND", "Target not found");
        return;
      }
      recordAudit(actorFromRequest(req), "ws_proxy_target.delete", name);
      res.status(200).json({ status: "deleted", name });
    },
  );

  app.post(
    "/admin-api/ws-proxy-targets/:name/disconnect-all",
    adminAuth,
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
}
