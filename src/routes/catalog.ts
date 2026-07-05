import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { config } from "../config.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { performRestRegistration, performMcpRegistration } from "./register.js";
import {
  listCatalog,
  getCatalogEntry,
  createCustomEntry,
  updateCustomEntry,
  deleteCustomEntry,
  type CustomCatalogEntryInput,
  type CatalogMutationError,
} from "../catalog/index.js";
import { requestId, sendError, validationError, notFound, forbidden } from "./http-errors.js";

function statusForCatalogError(code: CatalogMutationError["code"]): number {
  switch (code) {
    case "INVALID_SLUG":
      return 400;
    case "ALREADY_EXISTS":
      return 409;
    case "NOT_FOUND":
      return 404;
    case "IMMUTABLE_ENTRY":
      return 403;
  }
}

function stringArrayOrUndefined(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Parses+validates the mutable fields of a custom catalog entry from a request body. Returns a validation message on failure. */
function parseCustomEntryInput(
  body: Record<string, unknown>,
  requireSlug: boolean,
): { ok: true; value: Partial<CustomCatalogEntryInput> } | { ok: false; message: string } {
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
  app.get("/admin-api/catalog", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listCatalog() });
  });

  app.post("/admin-api/catalog", adminAuth, requireAdminRole, (req: Request, res: Response) => {
    const body = (req.body as Record<string, unknown>) ?? {};
    const parsed = parseCustomEntryInput(body, true);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const actor = actorFromRequest(req);
    const result = createCustomEntry(parsed.value as CustomCatalogEntryInput, actor);
    if (!result.ok) {
      sendError(res, statusForCatalogError(result.error.code), result.error.code, result.error.message);
      return;
    }
    recordAudit(actor, "catalog.entry.create", result.entry.slug, { kind: result.entry.kind });
    res.status(201).json({ ...result.entry, id: `custom:${result.entry.id}`, source: "custom" });
  });

  app.patch("/admin-api/catalog/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
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
    const body = (req.body as Record<string, unknown>) ?? {};
    const parsed = parseCustomEntryInput(body, false);
    if (!parsed.ok) {
      validationError(res, parsed.message);
      return;
    }
    const result = updateCustomEntry(rowId, parsed.value);
    if (!result.ok) {
      sendError(res, statusForCatalogError(result.error.code), result.error.code, result.error.message);
      return;
    }
    recordAudit(actorFromRequest(req), "catalog.entry.update", result.entry.slug, {
      fields: Object.keys(parsed.value),
    });
    res.status(200).json({ ...result.entry, id: `custom:${result.entry.id}`, source: "custom" });
  });

  app.delete("/admin-api/catalog/:id", adminAuth, requireAdminRole, (req: Request<{ id: string }>, res: Response) => {
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

  app.post(
    "/admin-api/catalog/:id/install",
    adminAuth,
    requireAdminRole,
    rateLimitRegister(config.rateLimitRegister),
    async (req: Request<{ id: string }>, res: Response) => {
      const entry = getCatalogEntry(req.params.id);
      if (!entry) {
        notFound(res, "CATALOG_ENTRY_NOT_FOUND", "Catalog entry not found");
        return;
      }
      const body = (req.body as Record<string, unknown>) ?? {};
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
}
