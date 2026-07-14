import { Router } from "express";
import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { registry } from "../mcp/registry.js";
import { config } from "../config.js";
import {
  listBundles,
  getBundleDetail,
  createBundle,
  updateBundle,
  deleteBundle,
  type BundleToolRef,
  type BundleMutationError,
} from "../admin/tool-composition/bundles.js";
import {
  createInstallLink,
  listInstallLinks,
  revokeInstallLink,
  revokeAllInstallLinksForBundle,
  type InstallLinkMutationError,
} from "../admin/tool-composition/bundle-install-links.js";
import { sendError, validationError, notFound, bodyOf } from "./http-errors.js";
import { type ValidationResult, mutationErrorToStatus } from "./validation.js";

const BUNDLE_ERROR_STATUS: Record<BundleMutationError["code"], number> = {
  INVALID_NAME: 400,
  UNKNOWN_TOOL: 400,
  ALREADY_EXISTS: 409,
  NOT_FOUND: 404,
};

const INSTALL_LINK_ERROR_STATUS: Record<InstallLinkMutationError["code"], number> = {
  BUNDLE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  EMPTY_BUNDLE: 400,
  SECRET_BOX_NOT_CONFIGURED: 501,
  SECRETS_PROVIDER_ERROR: 502,
  ALREADY_REVOKED: 409,
};

/** expiresAt is optional and, when present, must be a positive epoch-ms number — same shape as mcp-keys' validateExpiresAt. */
function validateExpiresAt(input: unknown): ValidationResult<number | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return { ok: false, message: "expiresAt must be a positive epoch-ms number or null" };
  }
  return { ok: true, value: input };
}

/** Same maxToolsPerClient cap /register applies to a client's tools[] — a bundle's tools[] is bounded the same way. */
function validateToolRefs(input: unknown): ValidationResult<BundleToolRef[]> {
  if (!Array.isArray(input)) {
    return { ok: false, message: "tools must be an array" };
  }
  if (input.length > config.maxToolsPerClient) {
    return { ok: false, message: `tools exceeds maximum of ${config.maxToolsPerClient}` };
  }
  const value: BundleToolRef[] = [];
  for (const item of input) {
    const entry = item as Record<string, unknown>;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.client !== "string" ||
      typeof entry.tool !== "string" ||
      !entry.client ||
      !entry.tool
    ) {
      return { ok: false, message: "each tools[] entry must be {client: string, tool: string}" };
    }
    value.push({ client: entry.client, tool: entry.tool });
  }
  return { ok: true, value };
}

/** Same shape/cap discipline as validateToolRefs — existence against composite_tools is checked downstream by createBundle/updateBundle. */
function validateCompositeRefs(input: unknown): ValidationResult<string[]> {
  if (!Array.isArray(input)) {
    return { ok: false, message: "composites must be an array" };
  }
  if (input.length > config.maxToolsPerClient) {
    return { ok: false, message: `composites exceeds maximum of ${config.maxToolsPerClient}` };
  }
  if (!input.every((x) => typeof x === "string" && x.length > 0)) {
    return { ok: false, message: "each composites[] entry must be a non-empty string" };
  }
  return { ok: true, value: input as string[] };
}

export function bundleRoutes(app: Express): void {
  // One shared admin-auth gate for every route in this file (mounted under
  // /admin-api below), instead of repeating adminAuth on each handler.
  const r = Router();
  r.use(adminAuth);

  // ── Bundles ─────────────────────────────────────────────────────────────

  r.get("/bundles", (_req: Request, res: Response) => {
    res.status(200).json({ items: listBundles() });
  });

  r.get("/bundles/:name", (req: Request<{ name: string }>, res: Response) => {
    const detail = getBundleDetail(req.params.name);
    if (!detail) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
      return;
    }
    res.status(200).json(detail);
  });

  r.post("/bundles", requireAdminRole, async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const name = typeof body.name === "string" ? body.name : "";
    const description = typeof body.description === "string" ? body.description : undefined;

    const toolsResult = validateToolRefs(body.tools ?? []);
    if (!toolsResult.ok) {
      validationError(res, toolsResult.message);
      return;
    }

    const compositesResult = validateCompositeRefs(body.composites ?? []);
    if (!compositesResult.ok) {
      validationError(res, compositesResult.message);
      return;
    }

    const actor = actorFromRequest(req);
    const result = await createBundle(name, description, toolsResult.value, actor, compositesResult.value);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, BUNDLE_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actor, "bundle.create", name, {
      tools_count: toolsResult.value.length,
      composites_count: compositesResult.value.length,
    });
    res.status(201).json(getBundleDetail(name));
  });

  r.patch("/bundles/:name", requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const body = bodyOf(req);
    const actor = actorFromRequest(req);

    const updates: {
      description?: string | null;
      enabled?: boolean;
      tools?: BundleToolRef[];
      composites?: string[];
    } = {};

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== "string") {
        validationError(res, "description must be a string or null");
        return;
      }
      updates.description = body.description;
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        validationError(res, "enabled must be a boolean");
        return;
      }
      updates.enabled = body.enabled;
    }

    if (body.tools !== undefined) {
      const toolsResult = validateToolRefs(body.tools);
      if (!toolsResult.ok) {
        validationError(res, toolsResult.message);
        return;
      }
      updates.tools = toolsResult.value;
    }

    if (body.composites !== undefined) {
      const compositesResult = validateCompositeRefs(body.composites);
      if (!compositesResult.ok) {
        validationError(res, compositesResult.message);
        return;
      }
      updates.composites = compositesResult.value;
    }

    const result = await updateBundle(name, updates);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, BUNDLE_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actor, "bundle.update", name, { fields: Object.keys(updates) });
    res.status(200).json({ status: "updated", name });
  });

  r.delete("/bundles/:name", requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    // Revoke any still-active install links (and their auto-provisioned MCP
    // keys) BEFORE the bundle row disappears — mcp_bundles' ON DELETE CASCADE
    // only removes the link rows, it never touches the separately-owned
    // mcp_api_keys rows they reference, so this is the one place that can
    // still see (bundle_name -> link -> key) to close that out.
    revokeAllInstallLinksForBundle(name);
    const ok = await deleteBundle(name);
    if (!ok) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
      return;
    }
    recordAudit(actorFromRequest(req), "bundle.delete", name);
    res.status(200).json({ status: "deleted", name });
  });

  // ── Install links ───────────────────────────────────────────────────────
  // Shareable, revocable "install this bundle" links — see
  // src/bundle-install-links.ts and the public src/routes/install-links.ts
  // (GET /install/:token) for the teammate-facing side of this feature.
  // Bundles carry no tenancy scoping of their own today (see bundles.ts /
  // routes/bundles.ts above — every bundle route here is adminAuth only, no
  // ensureClientAccess/canAccessClient check), so these routes match that.

  r.post("/bundles/:name/install-links", requireAdminRole, async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const body = bodyOf(req);
    const exp = validateExpiresAt(body.expiresAt);
    if (!exp.ok) {
      validationError(res, exp.message);
      return;
    }

    const actor = actorFromRequest(req);
    const result = await createInstallLink(name, exp.value, actor);
    if (!result.ok) {
      sendError(
        res,
        mutationErrorToStatus(result.error.code, INSTALL_LINK_ERROR_STATUS),
        result.error.code,
        result.error.message,
      );
      return;
    }
    recordAudit(actor, "bundle.install_link.create", name, { installLinkId: result.record.id });
    // The raw token is returned exactly once, here — it is never persisted or retrievable again.
    res.status(201).json({ ...result.record, token: result.rawToken });
  });

  r.get("/bundles/:name/install-links", (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!getBundleDetail(name)) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
      return;
    }
    res.status(200).json({ items: listInstallLinks(name) });
  });

  r.delete(
    "/bundles/:name/install-links/:id",
    requireAdminRole,
    (req: Request<{ name: string; id: string }>, res: Response) => {
      const { name } = req.params;
      const id = Number(req.params.id);
      const result = revokeInstallLink(name, id);
      if (!result.ok) {
        sendError(
          res,
          mutationErrorToStatus(result.error.code, INSTALL_LINK_ERROR_STATUS),
          result.error.code,
          result.error.message,
        );
        return;
      }
      recordAudit(actorFromRequest(req), "bundle.install_link.revoke", name, { installLinkId: id });
      res.status(200).json({ status: "revoked", id });
    },
  );

  // ── Tool picker ─────────────────────────────────────────────────────────
  // Flat listing across every registered client (live or not), unpaginated —
  // purpose-built so the admin-ui bundle picker doesn't N+1-fetch per client.

  r.get("/tools", (_req: Request, res: Response) => {
    res.status(200).json({ items: registry.listAllTools() });
  });

  app.use("/admin-api", r);
}
