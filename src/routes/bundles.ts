import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { registry } from "../registry.js";
import { config } from "../config.js";
import {
  listBundles,
  getBundleDetail,
  createBundle,
  updateBundle,
  deleteBundle,
  type BundleToolRef,
  type BundleMutationError,
} from "../bundles.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

function statusForBundleError(code: BundleMutationError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "UNKNOWN_TOOL":
      return 400;
    case "ALREADY_EXISTS":
      return 409;
    case "NOT_FOUND":
      return 404;
  }
}

/** Same maxToolsPerClient cap /register applies to a client's tools[] — a bundle's tools[] is bounded the same way. */
function validateToolRefs(input: unknown): { ok: true; value: BundleToolRef[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) {
    return { ok: false, message: "tools must be an array" };
  }
  if (input.length > config.maxToolsPerClient) {
    return { ok: false, message: `tools exceeds maximum of ${config.maxToolsPerClient}` };
  }
  const value: BundleToolRef[] = [];
  for (const item of input) {
    const entry = item as Record<string, unknown>;
    if (typeof entry !== "object" || entry === null || typeof entry.client !== "string" || typeof entry.tool !== "string" || !entry.client || !entry.tool) {
      return { ok: false, message: "each tools[] entry must be {client: string, tool: string}" };
    }
    value.push({ client: entry.client, tool: entry.tool });
  }
  return { ok: true, value };
}

export function bundleRoutes(app: Express): void {
  // ── Bundles ─────────────────────────────────────────────────────────────

  app.get("/admin-api/bundles", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listBundles() });
  });

  app.get("/admin-api/bundles/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const detail = getBundleDetail(req.params.name);
    if (!detail) {
      res.status(404).json({ error: { code: "BUNDLE_NOT_FOUND", message: "Bundle not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(detail);
  });

  app.post("/admin-api/bundles", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const description = typeof body.description === "string" ? body.description : undefined;

    const toolsResult = validateToolRefs(body.tools ?? []);
    if (!toolsResult.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: toolsResult.message, request_id: requestId(res) } });
      return;
    }

    const actor = actorFromRequest(req);
    const result = await createBundle(name, description, toolsResult.value, actor);
    if (!result.ok) {
      res.status(statusForBundleError(result.error.code)).json({ error: { ...result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actor, "bundle.create", name, { tools_count: toolsResult.value.length });
    res.status(201).json(getBundleDetail(name));
  });

  app.patch("/admin-api/bundles/:name", adminAuth, requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const body = (req.body as Record<string, unknown>) ?? {};
    const actor = actorFromRequest(req);

    const updates: { description?: string | null; enabled?: boolean; tools?: BundleToolRef[] } = {};

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== "string") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "description must be a string or null", request_id: requestId(res) } });
        return;
      }
      updates.description = body.description;
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "enabled must be a boolean", request_id: requestId(res) } });
        return;
      }
      updates.enabled = body.enabled;
    }

    if (body.tools !== undefined) {
      const toolsResult = validateToolRefs(body.tools);
      if (!toolsResult.ok) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: toolsResult.message, request_id: requestId(res) } });
        return;
      }
      updates.tools = toolsResult.value;
    }

    const result = await updateBundle(name, updates);
    if (!result.ok) {
      res.status(statusForBundleError(result.error.code)).json({ error: { ...result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actor, "bundle.update", name, { fields: Object.keys(updates) });
    res.status(200).json({ status: "updated", name });
  });

  app.delete("/admin-api/bundles/:name", adminAuth, requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const ok = await deleteBundle(name);
    if (!ok) {
      res.status(404).json({ error: { code: "BUNDLE_NOT_FOUND", message: "Bundle not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "bundle.delete", name);
    res.status(200).json({ status: "deleted", name });
  });

  // ── Tool picker ─────────────────────────────────────────────────────────
  // Flat listing across every registered client (live or not), unpaginated —
  // purpose-built so the admin-ui bundle picker doesn't N+1-fetch per client.

  app.get("/admin-api/tools", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: registry.listAllTools() });
  });
}
