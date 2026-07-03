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
import {
  createInstallLink,
  listInstallLinks,
  revokeInstallLink,
  revokeAllInstallLinksForBundle,
  type InstallLinkMutationError,
} from "../bundle-install-links.js";
import { sendError, validationError, notFound } from "./http-errors.js";

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

function statusForInstallLinkError(code: InstallLinkMutationError["code"]): number {
  switch (code) {
    case "BUNDLE_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "EMPTY_BUNDLE":
      return 400;
    case "SECRET_BOX_NOT_CONFIGURED":
      return 501;
    case "SECRETS_PROVIDER_ERROR":
      return 502;
    case "ALREADY_REVOKED":
      return 409;
  }
}

/** expiresAt is optional and, when present, must be a positive epoch-ms number — same shape as mcp-keys' validateExpiresAt. */
function validateExpiresAt(input: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return { ok: false, message: "expiresAt must be a positive epoch-ms number or null" };
  }
  return { ok: true, value: input };
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

export function bundleRoutes(app: Express): void {
  // ── Bundles ─────────────────────────────────────────────────────────────

  app.get("/admin-api/bundles", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: listBundles() });
  });

  app.get("/admin-api/bundles/:name", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const detail = getBundleDetail(req.params.name);
    if (!detail) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
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
      validationError(res, toolsResult.message);
      return;
    }

    const actor = actorFromRequest(req);
    const result = await createBundle(name, description, toolsResult.value, actor);
    if (!result.ok) {
      sendError(res, statusForBundleError(result.error.code), result.error.code, result.error.message);
      return;
    }
    recordAudit(actor, "bundle.create", name, { tools_count: toolsResult.value.length });
    res.status(201).json(getBundleDetail(name));
  });

  app.patch(
    "/admin-api/bundles/:name",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const body = (req.body as Record<string, unknown>) ?? {};
      const actor = actorFromRequest(req);

      const updates: { description?: string | null; enabled?: boolean; tools?: BundleToolRef[] } = {};

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

      const result = await updateBundle(name, updates);
      if (!result.ok) {
        sendError(res, statusForBundleError(result.error.code), result.error.code, result.error.message);
        return;
      }
      recordAudit(actor, "bundle.update", name, { fields: Object.keys(updates) });
      res.status(200).json({ status: "updated", name });
    },
  );

  app.delete(
    "/admin-api/bundles/:name",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ name: string }>, res: Response) => {
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
    },
  );

  // ── Install links ───────────────────────────────────────────────────────
  // Shareable, revocable "install this bundle" links — see
  // src/bundle-install-links.ts and the public src/routes/install-links.ts
  // (GET /install/:token) for the teammate-facing side of this feature.
  // Bundles carry no tenancy scoping of their own today (see bundles.ts /
  // routes/bundles.ts above — every bundle route here is adminAuth only, no
  // ensureClientAccess/canAccessClient check), so these routes match that.

  app.post(
    "/admin-api/bundles/:name/install-links",
    adminAuth,
    requireAdminRole,
    async (req: Request<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const body = (req.body as Record<string, unknown>) ?? {};
      const exp = validateExpiresAt(body.expiresAt);
      if (!exp.ok) {
        validationError(res, exp.message);
        return;
      }

      const actor = actorFromRequest(req);
      const result = await createInstallLink(name, exp.value, actor);
      if (!result.ok) {
        sendError(res, statusForInstallLinkError(result.error.code), result.error.code, result.error.message);
        return;
      }
      recordAudit(actor, "bundle.install_link.create", name, { installLinkId: result.record.id });
      // The raw token is returned exactly once, here — it is never persisted or retrievable again.
      res.status(201).json({ ...result.record, token: result.rawToken });
    },
  );

  app.get("/admin-api/bundles/:name/install-links", adminAuth, (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!getBundleDetail(name)) {
      notFound(res, "BUNDLE_NOT_FOUND", "Bundle not found");
      return;
    }
    res.status(200).json({ items: listInstallLinks(name) });
  });

  app.delete(
    "/admin-api/bundles/:name/install-links/:id",
    adminAuth,
    requireAdminRole,
    (req: Request<{ name: string; id: string }>, res: Response) => {
      const { name } = req.params;
      const id = Number(req.params.id);
      const result = revokeInstallLink(name, id);
      if (!result.ok) {
        sendError(res, statusForInstallLinkError(result.error.code), result.error.code, result.error.message);
        return;
      }
      recordAudit(actorFromRequest(req), "bundle.install_link.revoke", name, { installLinkId: id });
      res.status(200).json({ status: "revoked", id });
    },
  );

  // ── Tool picker ─────────────────────────────────────────────────────────
  // Flat listing across every registered client (live or not), unpaginated —
  // purpose-built so the admin-ui bundle picker doesn't N+1-fetch per client.

  app.get("/admin-api/tools", adminAuth, (_req: Request, res: Response) => {
    res.status(200).json({ items: registry.listAllTools() });
  });
}
