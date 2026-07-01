import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import {
  listComposites,
  getCompositeDetail,
  createComposite,
  updateComposite,
  deleteComposite,
  type CompositeStep,
  type CompositeMutationError,
} from "../composites.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

const MAX_STEPS = 10;

function statusForError(code: CompositeMutationError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "INVALID_SCHEMA":
    case "INVALID_STEPS":
    case "UNKNOWN_TOOL":
      return 400;
    case "ALREADY_EXISTS":
      return 409;
    case "NOT_FOUND":
      return 404;
  }
}

function validateSteps(input: unknown): { ok: true; value: CompositeStep[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "steps must be an array" };
  if (input.length === 0) return { ok: false, message: "a composite needs at least one step" };
  if (input.length > MAX_STEPS) return { ok: false, message: `steps exceeds maximum of ${MAX_STEPS}` };
  const value: CompositeStep[] = [];
  for (const item of input) {
    const e = item as Record<string, unknown>;
    if (typeof e !== "object" || e === null || typeof e.targetClient !== "string" || typeof e.targetTool !== "string") {
      return { ok: false, message: "each step must be {targetClient: string, targetTool: string, argsTemplate: object}" };
    }
    const tmpl = e.argsTemplate ?? {};
    if (typeof tmpl !== "object" || tmpl === null || Array.isArray(tmpl)) {
      return { ok: false, message: "each step's argsTemplate must be an object" };
    }
    if (JSON.stringify(tmpl).length > 10240) {
      return { ok: false, message: "argsTemplate exceeds 10KB" };
    }
    value.push({ targetClient: e.targetClient, targetTool: e.targetTool, argsTemplate: tmpl as Record<string, unknown> });
  }
  return { ok: true, value };
}

export function compositeRoutes(app: Express): void {
  app.get("/admin-api/composites", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listComposites() });
  });

  app.get("/admin-api/composites/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const detail = getCompositeDetail(req.params.name);
    if (!detail) {
      res.status(404).json({ error: { code: "COMPOSITE_NOT_FOUND", message: "Composite not found", request_id: requestId(res) } });
      return;
    }
    res.status(200).json(detail);
  });

  app.post("/admin-api/composites", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const description = typeof body.description === "string" ? body.description : undefined;
    const inputSchema = (typeof body.inputSchema === "object" && body.inputSchema !== null ? body.inputSchema : { type: "object", properties: {} }) as Record<string, unknown>;

    const stepsResult = validateSteps(body.steps);
    if (!stepsResult.ok) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: stepsResult.message, request_id: requestId(res) } });
      return;
    }

    const actor = actorFromRequest(req);
    const result = await createComposite(name, description, inputSchema, stepsResult.value, actor);
    if (!result.ok) {
      res.status(statusForError(result.error.code)).json({ error: { ...result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actor, "composite.create", name, { steps: stepsResult.value.length });
    res.status(201).json(getCompositeDetail(name));
  });

  app.patch("/admin-api/composites/:name", adminAuth, requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const body = (req.body as Record<string, unknown>) ?? {};
    const updates: { description?: string | null; enabled?: boolean; inputSchema?: Record<string, unknown>; steps?: CompositeStep[] } = {};

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
    if (body.inputSchema !== undefined) {
      if (typeof body.inputSchema !== "object" || body.inputSchema === null || Array.isArray(body.inputSchema)) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "inputSchema must be an object", request_id: requestId(res) } });
        return;
      }
      updates.inputSchema = body.inputSchema as Record<string, unknown>;
    }
    if (body.steps !== undefined) {
      const stepsResult = validateSteps(body.steps);
      if (!stepsResult.ok) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: stepsResult.message, request_id: requestId(res) } });
        return;
      }
      updates.steps = stepsResult.value;
    }

    const result = await updateComposite(name, updates);
    if (!result.ok) {
      res.status(statusForError(result.error.code)).json({ error: { ...result.error, request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "composite.update", name, { fields: Object.keys(updates) });
    res.status(200).json({ status: "updated", name });
  });

  app.delete("/admin-api/composites/:name", adminAuth, requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const ok = await deleteComposite(name);
    if (!ok) {
      res.status(404).json({ error: { code: "COMPOSITE_NOT_FOUND", message: "Composite not found", request_id: requestId(res) } });
      return;
    }
    recordAudit(actorFromRequest(req), "composite.delete", name);
    res.status(200).json({ status: "deleted", name });
  });
}
