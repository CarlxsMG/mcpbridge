import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole, requireSuperAdmin } from "../middleware/authz.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { config } from "../config.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { performRestRegistration, performMcpRegistration } from "../mcp/registration.js";
import {
  listCatalog,
  getCatalogEntry,
  createCustomEntry,
  updateCustomEntry,
  deleteCustomEntry,
  type CustomCatalogEntryInput,
  type CatalogMutationError,
} from "../catalog/index.js";
import { requestId, sendError, validationError, notFound, forbidden, bodyOf } from "./http-errors.js";
import { type ValidationResult, mutationErrorToStatus } from "./validation.js";

const CATALOG_ERROR_STATUS: Record<CatalogMutationError["code"], number> = {
  INVALID_SLUG: 400,
  ALREADY_EXISTS: 409,
  NOT_FOUND: 404,
  IMMUTABLE_ENTRY: 403,
};

function stringArrayOrUndefined(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Parses+validates the mutable fields of a custom catalog entry from a request body. Returns a validation message on failure. */
function parseCustomEntryInput(
  body: Record<string, unknown>,
  requireSlug: boolean,
): ValidationResult<Partial<CustomCatalogEntryInput>> {
  const value: Partial<CustomCatalogEntryInput> = {};
  if (requireSlug || body.slug !== undefined) {
    if (typeof body.slug !== "string" || !body.slug) return { ok: false, message: "slug is required" };
    value.slug = body.slug;
  }
  if (requireSlug || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name) return { ok: false, message: "name is required" };
    value.name = body.name;
  }
  if (requireSlug || body.kind !== undefined) {
    if (body.kind !== "rest" && body.kind !== "mcp") return { ok: false, message: "kind must be 'rest' or 'mcp'" };
    value.kind = body.kind;
  }
  if (body.description !== undefined)
    value.description = typeof body.description === "string" ? body.description : null;
  if (body.category !== undefined) value.category = typeof body.category === "string" ? body.category : null;
  if (body.icon !== undefined) value.icon = typeof body.icon === "string" ? body.icon : null;
  if (body.tags !== undefined) value.tags = stringArrayOrUndefined(body.tags) ?? [];
  if (body.openapiUrl !== undefined) value.openapiUrl = typeof body.openapiUrl === "string" ? body.openapiUrl : null;
  if (body.healthUrl !== undefined) value.healthUrl = typeof body.healthUrl === "string" ? body.healthUrl : null;
  if (body.baseUrl !== undefined) value.baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : null;
  if (body.includeTags !== undefined) value.includeTags = stringArrayOrUndefined(body.includeTags) ?? null;
  if (body.excludeOperations !== undefined)
    value.excludeOperations = stringArrayOrUndefined(body.excludeOperations) ?? null;
  if (body.mcpUrl !== undefined) value.mcpUrl = typeof body.mcpUrl === "string" ? body.mcpUrl : null;
  if (body.mcpTransport !== undefined) {
    if (body.mcpTransport !== "streamable-http" && body.mcpTransport !== "sse" && body.mcpTransport !== null) {
      return { ok: false, message: "mcpTransport must be 'streamable-http', 'sse', or null" };
    }
    value.mcpTransport = body.mcpTransport;
  }
  if (body.featured !== undefined) value.featured = Boolean(body.featured);
  return { ok: true, value };
}

/**
 * Catalog/marketplace: a merged view of the static builtin gallery
 * (src/catalog/builtin.ts) and admin-authored custom entries, with one-click
 * "install" that reuses the exact same SSRF-validated registration logic as
 * POST /register (performRestRegistration/performMcpRegistration) — a
 * catalog entry is never a shortcut around that validation, curated or not.
 */
export function catalogRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  r.get("/catalog", (_req: Request, res: Response) => {
    res.status(200).json({ items: listCatalog() });
  });

  // POST/PATCH/DELETE require a super-admin: catalog_entries carries no
  // tenancy of its own (no team_id column) — it's a single shared marketplace
  // every tenant's admin sees and one-click installs from — so a team-scoped
  // admin must not be able to plant, retarget, or remove an entry another
  // team relies on (same rationale as composites.ts/bundles.ts's
  // requireSuperAdmin gate, extended here to DELETE too since a catalog entry
  // itself, not just its creation, is the shared/global resource).
  r.post("/catalog", requireSuperAdmin, (req: Request, res: Response) => {
    const body = bodyOf(req);
    const parsed = parseCustomEntryInput(body, true);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const actor = actorFromRequest(req);
    const result = createCustomEntry(parsed.value as CustomCatalogEntryInput, actor);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, CATALOG_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actor, "catalog.entry.create", result.entry.slug, { kind: result.entry.kind });
    res.status(201).json({ ...result.entry, id: `custom:${result.entry.id}`, source: "custom" });
  });

  r.patch("/catalog/:id", requireSuperAdmin, (req: Request<{ id: string }>, res: Response) => {
    const { id } = req.params;
    if (id.startsWith("builtin:")) {
      forbidden(res, "IMMUTABLE_ENTRY", "Builtin catalog entries can't be edited at runtime");
      return;
    }
    if (!id.startsWith("custom:")) {
      notFound(res, "NOT_FOUND", "Catalog entry not found");
      return;
    }
    const rowId = Number(id.slice("custom:".length));
    const body = bodyOf(req);
    const parsed = parseCustomEntryInput(body, false);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const result = updateCustomEntry(rowId, parsed.value);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, CATALOG_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actorFromRequest(req), "catalog.entry.update", result.entry.slug, {
      fields: Object.keys(parsed.value),
    });
    res.status(200).json({ ...result.entry, id: `custom:${result.entry.id}`, source: "custom" });
  });

  r.delete("/catalog/:id", requireSuperAdmin, (req: Request<{ id: string }>, res: Response) => {
    const { id } = req.params;
    if (id.startsWith("builtin:")) {
      forbidden(res, "IMMUTABLE_ENTRY", "Builtin catalog entries can't be deleted");
      return;
    }
    if (!id.startsWith("custom:")) {
      notFound(res, "NOT_FOUND", "Catalog entry not found");
      return;
    }
    const rowId = Number(id.slice("custom:".length));
    if (!deleteCustomEntry(rowId)) {
      notFound(res, "NOT_FOUND", "Catalog entry not found");
      return;
    }
    recordAudit(actorFromRequest(req), "catalog.entry.delete", id);
    res.status(200).json({ status: "deleted", id });
  });

  r.post(
    "/catalog/:id/install",
    requireAdminRole,
    rateLimitRegister(config.rateLimitRegister),
    async (req: Request<{ id: string }>, res: Response) => {
      const entry = getCatalogEntry(req.params.id);
      if (!entry) {
        notFound(res, "CATALOG_ENTRY_NOT_FOUND", "Catalog entry not found");
        return;
      }
      const body = bodyOf(req);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : entry.slug;
      const peerIp = req.socket?.remoteAddress;
      const reqId = requestId(res);

      const outcome =
        entry.kind === "mcp"
          ? await performMcpRegistration(
              { name, mcp_url: entry.mcpUrl, mcp_transport: entry.mcpTransport ?? "streamable-http" },
              peerIp,
              reqId,
            )
          : await performRestRegistration(
              {
                name,
                health_url: entry.healthUrl ?? entry.baseUrl,
                base_url: entry.baseUrl,
                openapi_url: entry.openapiUrl,
                include_tags: entry.includeTags ?? undefined,
                exclude_operations: entry.excludeOperations ?? undefined,
              },
              peerIp,
              reqId,
            );

      res.status(outcome.status).json(outcome.body);
      if (outcome.ok) {
        recordAudit(actorFromRequest(req), "catalog.install", entry.id, {
          installedAs: name,
          toolsCount: outcome.body.tools_count,
        });
      }
    },
  );

  app.use("/admin-api", r);
}
