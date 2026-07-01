import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";
import { TOOL_KEY_SEPARATOR } from "../registry.js";
import { listAllTags, listToolsByTag, setToolTags, normalizeTag, TAG_RE } from "../tool-tags.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

export function tagRoutes(app: Express): void {
  app.get("/admin-api/tags", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listAllTags() });
  });

  app.get("/admin-api/tags/:tag/tools", adminAuth, (req: Request<{ tag: string }>, res: Response) => {
    res.status(200).json({ items: listToolsByTag(req.params.tag) });
  });

  app.put(
    "/admin-api/clients/:name/tools/:tool/tags",
    adminAuth,
    requireAdminRole,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      const body = (req.body as Record<string, unknown>) ?? {};
      if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "tags must be an array of strings", request_id: requestId(res) } });
        return;
      }
      const normalized = (body.tags as string[]).map(normalizeTag);
      const invalid = normalized.find((t) => !TAG_RE.test(t));
      if (invalid !== undefined) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `invalid tag: "${invalid}" (lowercase alphanumeric, - and _, up to 32 chars)`, request_id: requestId(res) } });
        return;
      }
      const ok = setToolTags(name, tool, normalized);
      if (!ok) {
        res.status(404).json({ error: { code: "TOOL_NOT_FOUND", message: "Client or tool not found", request_id: requestId(res) } });
        return;
      }
      recordAudit(actorFromRequest(req), "tool.tags.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { tags: normalized });
      res.status(200).json({ status: "updated", name, tool, tags: normalized });
    }
  );
}
