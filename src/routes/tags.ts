import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, ensureClientAccess, callerTeamId } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { TOOL_KEY_SEPARATOR } from "../lib/identifier.js";
import { listAllTags, listToolsByTag, setToolTags, normalizeTag, TAG_RE } from "../tool-meta/tool-tags.js";
import { validationError, notFound, bodyOf } from "./http-errors.js";

export function tagRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/tags", (req: Request, res: Response) => {
    const teamId = callerTeamId(req);
    res.status(200).json({ items: listAllTags(typeof teamId === "number" ? teamId : undefined) });
  });

  r.get("/tags/:tag/tools", (req: Request<{ tag: string }>, res: Response) => {
    const teamId = callerTeamId(req);
    res.status(200).json({ items: listToolsByTag(req.params.tag, typeof teamId === "number" ? teamId : undefined) });
  });

  r.put(
    "/clients/:name/tools/:tool/tags",
    requireAdminRole,
    (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = bodyOf(req);
      if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
        validationError(res, "tags must be an array of strings");
        return;
      }
      const normalized = (body.tags as string[]).map(normalizeTag);
      const invalid = normalized.find((t) => !TAG_RE.test(t));
      if (invalid !== undefined) {
        validationError(res, `invalid tag: "${invalid}" (lowercase alphanumeric, - and _, up to 32 chars)`);
        return;
      }
      const ok = setToolTags(name, tool, normalized);
      if (!ok) {
        notFound(res, "TOOL_NOT_FOUND", "Client or tool not found");
        return;
      }
      recordAudit(actorFromRequest(req), "tool.tags.set", `${name}${TOOL_KEY_SEPARATOR}${tool}`, { tags: normalized });
      res.status(200).json({ status: "updated", name, tool, tags: normalized });
    },
  );

  app.use("/admin-api", r);
}
