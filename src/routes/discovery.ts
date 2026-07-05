import type { Request, Response, Express } from "express";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "./admin.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../net/ip-validator.js";
import { discoverToolsFromOpenApi } from "../discovery/openapi-discovery.js";
import { discoverToolsFromGraphQl } from "../discovery/graphql-discovery.js";
import { parseCurlCommand, parsePostmanCollection } from "../discovery/curl-postman-discovery.js";
import { validateEndpointPath } from "../mcp/registry.js";
import type { RestToolDefinition } from "../mcp/types.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { sendError, validationError } from "./http-errors.js";

function stringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const arr = input.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

/**
 * Shared response shape for every branch of POST /admin-api/discovery/preview
 * below — same envelope regardless of which discovery source was used.
 */
function sendToolsPreview(res: Response, tools: RestToolDefinition[]): void {
  res.status(200).json({
    count: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      method: t.method,
      endpoint: t.endpoint,
      description: t.description,
    })),
  });
}

/**
 * Validates a parsed/manual tools array the exact same way POST /register's
 * performRestRegistration does (endpoint path-traversal check + the
 * maxToolsPerClient cap) so the preview can never show a set of tools that
 * would then be rejected at actual registration time.
 */
function validateManualToolsForPreview(res: Response, tools: RestToolDefinition[]): boolean {
  if (tools.length > config.maxToolsPerClient) {
    validationError(res, `Parsed ${tools.length} tools, exceeds maximum of ${config.maxToolsPerClient}`);
    return false;
  }
  for (const t of tools) {
    if (typeof t?.endpoint === "string") {
      const pathError = validateEndpointPath(t.endpoint);
      if (pathError) {
        validationError(res, `Tool "${t.name}": ${pathError}`);
        return false;
      }
    }
  }
  return true;
}

/**
 * Admin-driven discovery *preview*: runs the same validation pipeline as
 * POST /register but returns the discovered/parsed tools WITHOUT persisting
 * anything. Powers the "Add server" wizard (see the tools before committing)
 * and the "Re-sync" diff (compare against a client's current tools). Applying
 * is still done via POST /register.
 *
 * Accepts exactly one discovery-source field, mirroring performRestRegistration's
 * mutually-exclusive set: 'openapi_url' (fetches + parses a live spec, the
 * only branch that needs SSRF validation since it's the only one that makes
 * an outbound request), or one of the three manual-shaped sources — a literal
 * 'tools' array, a raw 'curl_input' paste, or a 'postman_collection' export —
 * which all resolve to the same tools[] shape and share the same local,
 * network-free validation below.
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
      const curlInput = typeof body.curl_input === "string" ? body.curl_input : "";
      const postmanCollection = body.postman_collection;
      const manualTools = body.tools;

      const hasOpenapi = openapiUrl.length > 0;
      const hasCurl = curlInput.trim().length > 0;
      const hasPostman = postmanCollection !== undefined && postmanCollection !== null && postmanCollection !== "";
      const hasTools = Array.isArray(manualTools);

      if (hasOpenapi) {
        const includeTags = stringArray(body.include_tags);
        const excludeOperations = stringArray(body.exclude_operations);

        if (!openapiUrl.startsWith("http://") && !openapiUrl.startsWith("https://")) {
          validationError(res, "openapi_url must be an absolute http(s) URL");
          return;
        }

        const validation = await validateBackendUrl(openapiUrl, config.allowPrivateIps, config.allowedHosts);
        if (!validation.valid) {
          validationError(res, `Invalid openapi_url: ${validation.reason}`);
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
          sendToolsPreview(res, tools);
        } catch (err) {
          sendError(res, 400, "DISCOVERY_ERROR", err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (!hasCurl && !hasPostman && !hasTools) {
        validationError(res, "Provide one of 'openapi_url', 'tools', 'curl_input', or 'postman_collection'");
        return;
      }

      try {
        let tools: RestToolDefinition[];
        let source: string;
        if (hasCurl) {
          tools = parseCurlCommand(curlInput);
          source = "curl";
        } else if (hasPostman) {
          const collection = typeof postmanCollection === "string" ? JSON.parse(postmanCollection) : postmanCollection;
          tools = parsePostmanCollection(collection);
          source = "postman";
        } else {
          tools = manualTools as RestToolDefinition[];
          source = "manual";
        }

        if (!validateManualToolsForPreview(res, tools)) return;

        recordAudit(actorFromRequest(req), "discovery.preview_manual", source, { count: tools.length });
        sendToolsPreview(res, tools);
      } catch (err) {
        sendError(res, 400, "VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
      }
    },
  );

  /**
   * GraphQL counterpart of the OpenAPI preview above: runs introspection and
   * returns the discovered tools WITHOUT persisting. Introspection alone
   * cannot mutate server state, so preview is safe to run repeatedly.
   */
  app.post(
    "/admin-api/discovery/preview-graphql",
    adminAuth,
    requireAdminRole,
    rateLimitRegister(config.rateLimitRegister),
    async (req: Request, res: Response) => {
      const body = (req.body as Record<string, unknown>) ?? {};
      const graphqlUrl = typeof body.graphql_url === "string" ? body.graphql_url : "";

      if (!graphqlUrl.startsWith("http://") && !graphqlUrl.startsWith("https://")) {
        validationError(res, "graphql_url must be an absolute http(s) URL");
        return;
      }

      const validation = await validateBackendUrl(graphqlUrl, config.allowPrivateIps, config.allowedHosts);
      if (!validation.valid) {
        validationError(res, `Invalid graphql_url: ${validation.reason}`);
        return;
      }

      try {
        const hostname = new URL(graphqlUrl).hostname;
        const tools = await discoverToolsFromGraphQl({
          graphqlUrl,
          ipPin: { resolvedIp: validation.resolvedIp!, hostname },
          includeMutations: body.include_mutations !== false,
        });
        recordAudit(actorFromRequest(req), "discovery.preview_graphql", graphqlUrl, { count: tools.length });
        res.status(200).json({
          count: tools.length,
          tools: tools.map((t) => ({
            name: t.name,
            method: "POST",
            endpoint: new URL(graphqlUrl).pathname || "/graphql",
            description: t.description,
          })),
        });
      } catch (err) {
        sendError(res, 400, "DISCOVERY_ERROR", err instanceof Error ? err.message : String(err));
      }
    },
  );
}
