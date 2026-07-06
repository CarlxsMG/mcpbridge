import type { Request, Response, Router } from "express";
import { dispatchToolMutations } from "../../admin/tool-policies/tool-mutations.js";
import { requireOperator, ensureClientAccess } from "../../middleware/authz.js";
import { actorFromRequest } from "../../admin/audit/audit.js";
import { validationError } from "../http-errors.js";

/**
 * Mounts admin endpoints that haven't yet been promoted to a per-entity
 * router under `./<entity>.ts`. As of P0-2b this is the single mega-handler
 * `PATCH /clients/:name/tools/:tool` — the dispatcher it delegates to
 * (`dispatchToolMutations` in `src/admin/tool-policies/tool-mutations.ts`)
 * splits the 16 body keys into a per-key sub-handler table.
 *
 * Once every `ToolMutation` lives in its own file under
 * `src/admin/tool-policies/mutations/<key>.ts`, this file can be deleted
 * outright and `mountLegacy(r)` removed from `src/routes/admin/index.ts`.
 */
export function mountLegacy(parent: Router): void {
  // ── Tools ───────────────────────────────────────────────────────────────

  parent.patch(
    "/clients/:name/tools/:tool",
    requireOperator,
    async (req: Request<{ name: string; tool: string }>, res: Response) => {
      const { name, tool } = req.params;
      if (!ensureClientAccess(req, res, name)) return;
      const body = (req.body as Record<string, unknown>) ?? {};
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        validationError(res, "request body must be a JSON object");
        return;
      }

      const outcome = await dispatchToolMutations(body, { actor: actorFromRequest(req), clientName: name, toolName: tool }, res);
      if (outcome !== null) return; // dispatcher already wrote the error response
      res.status(200).json({ status: "updated", name, tool });
    },
  );
}
