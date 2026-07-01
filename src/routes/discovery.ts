import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../security/ip-validator.js";
import { discoverToolsFromOpenApi } from "../openapi-discovery.js";
import { recordAudit, actorFromRequest } from "../admin/audit.js";

function requestId(res: Response): string | null {
  return (res.locals.requestId as string) ?? null;
}

function stringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const arr = input.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

/**
 * Admin-driven OpenAPI discovery *preview*: runs the same SSRF-validated
 * discovery pipeline as POST /register but returns the discovered tools
 * WITHOUT persisting anything. Powers the "Add server" wizard (see the tools
 * before committing) and the "Re-sync" diff (compare against a client's
 * current tools). Applying is still done via POST /register.
 */
export function discoveryRoutes(app: Express): void {
  app.post(
    "/admin-api/discovery/preview",
    adminAuth,
    requireAdminRole,
    rateLimitRegister(config.rateLimitRegister),
    async (req: Request, res: Response) => {
      const body = (req.body as Record<string, unknown>) ?? {};
      const openapiUrl = typeof body.openapi_url === "string" ? body.openapi_url : "";
      const includeTags = stringArray(body.include_tags);
      const excludeOperations = stringArray(body.exclude_operations);

      if (!openapiUrl.startsWith("http://") && !openapiUrl.startsWith("https://")) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "openapi_url must be an absolute http(s) URL", request_id: requestId(res) } });
        return;
      }

      const validation = await validateBackendUrl(openapiUrl, config.allowPrivateIps, config.allowedHosts);
      if (!validation.valid) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid openapi_url: ${validation.reason}`, request_id: requestId(res) } });
        return;
      }

      try {
        const hostname = new URL(openapiUrl).hostname;
        const tools = await discoverToolsFromOpenApi({
          openapiUrl,
          ipPin: { resolvedIp: validation.resolvedIp!, hostname },
          includeTags,
          excludeOperations,
        });
        recordAudit(actorFromRequest(req), "discovery.preview", openapiUrl, { count: tools.length });
        res.status(200).json({
          count: tools.length,
          tools: tools.map((t) => ({ name: t.name, method: t.method, endpoint: t.endpoint, description: t.description })),
        });
      } catch (err) {
        res.status(400).json({ error: { code: "DISCOVERY_ERROR", message: err instanceof Error ? err.message : String(err), request_id: requestId(res) } });
      }
    }
  );
}
