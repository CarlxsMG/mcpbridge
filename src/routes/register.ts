import type { Request, Response, Express } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { registry, validateEndpointPath } from "../registry.js";
import { discoverToolsFromOpenApi } from "../openapi-discovery.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../security/ip-validator.js";
import { adminAuth } from "../middleware/auth.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { log } from "../logger.js";
import { discoverToolsFromMcpServer } from "../mcp-discovery.js";
import { getUpstreamAuthHeaders } from "../security/upstream-auth.js";
import type { McpTransport } from "../types.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type SchemaObject = { [k: string]: JsonValue };

// Cache the resolved schema once at module load time
function resolveRefs(obj: JsonValue, visited: WeakSet<object> = new WeakSet()): JsonValue {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => resolveRefs(item, visited));
  }
  if (visited.has(obj)) return ("$ref" in obj ? obj["$ref"] : obj) as JsonValue;
  visited.add(obj);
  if ("$ref" in obj && typeof obj["$ref"] === "string") {
    const refName = obj["$ref"].split("/").pop() as string;
    if (_schemaComponents == null) {
      throw new Error(`Cannot resolve $ref "${refName}": no schema components available`);
    }
    const refClone = JSON.parse(JSON.stringify(_schemaComponents[refName])) as JsonValue;
    return resolveRefs(refClone, visited);
  }
  const result: SchemaObject = {};
  for (const key of Object.keys(obj)) {
    result[key] = resolveRefs((obj as SchemaObject)[key], visited);
  }
  return result;
}

let _schemaComponents: Record<string, SchemaObject> | null = null;
let _resolvedSchema: SchemaObject | null = null;
try {
  const specPath = resolve(import.meta.dirname, "../openapi.yaml");
  const spec = parse(readFileSync(specPath, "utf-8")) as { components: { schemas: Record<string, SchemaObject> } };
  _schemaComponents = spec.components.schemas;
  _resolvedSchema = resolveRefs(JSON.parse(JSON.stringify(_schemaComponents["RegistrationPayload"]))) as SchemaObject;
} catch (err) {
  log("warn", "Failed to pre-load /register/schema", { error: String(err) });
}

export function registerRoutes(app: Express): void {
  app.post("/register", adminAuth, rateLimitRegister(config.rateLimitRegister), async (req: Request, res: Response) => {
    const requestId = (res.locals.requestId as string) ?? null;

    // Change A — guard against non-object bodies ([], "string", null, etc.)
    if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body must be a JSON object",
          request_id: requestId,
        },
      });
    }

    // Change B — cap tools[] length before any other processing
    if (Array.isArray((req.body as Record<string, unknown>).tools) && ((req.body as Record<string, unknown>).tools as unknown[]).length > config.maxToolsPerClient) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `tools[] exceeds maximum of ${config.maxToolsPerClient}`,
          request_id: requestId,
        },
      });
    }

    // MCP-upstream registration takes a distinct shape (mcp_url instead of
    // health_url + tools/openapi_url); same adminAuth + SSRF posture as REST.
    if ((req.body as Record<string, unknown>).kind === "mcp" || typeof (req.body as Record<string, unknown>).mcp_url === "string") {
      await handleMcpRegister(req, res, requestId);
      return;
    }

    const { name, tools, health_url, openapi_url, include_tags, exclude_operations, retry_non_safe_methods } = req.body;

    // Validate required fields
    if (!name || !health_url) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Missing required fields: name, health_url" } });
      return;
    }

    // Must provide either tools or openapi_url, not both
    if (!tools && !openapi_url) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Must provide either 'tools' or 'openapi_url'" } });
      return;
    }
    if (tools && openapi_url) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide 'tools' or 'openapi_url', not both" } });
      return;
    }

    // Change C — use the true peer address; req.ip follows X-Forwarded-For when
    // TRUST_PROXY is set, which is attacker-controlled.
    const peerAddress = req.socket?.remoteAddress;
    if (!health_url.startsWith("http") && !peerAddress) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Cannot determine peer IP for relative health_url",
          request_id: requestId,
        },
      });
      return;
    }
    const ip = peerAddress || "127.0.0.1";

    // Resolve health_url
    const resolvedHealthUrl = health_url.startsWith("http")
      ? health_url
      : `http://${ip}${health_url.startsWith("/") ? "" : "/"}${health_url}`;

    // Validate health_url against SSRF
    const healthValidation = await validateBackendUrl(resolvedHealthUrl, config.allowPrivateIps, config.allowedHosts);
    if (!healthValidation.valid) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid health_url: ${healthValidation.reason}` } });
      return;
    }

    // Resolve base_url
    const { base_url } = req.body;
    let resolvedBaseUrl: string;
    if (base_url) {
      if (!base_url.startsWith("http://") && !base_url.startsWith("https://")) {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "base_url must start with http:// or https://" } });
        return;
      }
      resolvedBaseUrl = base_url;
    } else {
      // Extract base from health_url
      try {
        const healthParsed = new URL(resolvedHealthUrl);
        resolvedBaseUrl = `${healthParsed.protocol}//${healthParsed.host}`;
      } catch {
        resolvedBaseUrl = `http://${ip}`;
      }
    }

    // Validate base_url against SSRF and capture pinned IP
    const baseUrlValidation = await validateBackendUrl(resolvedBaseUrl, config.allowPrivateIps, config.allowedHosts);
    if (!baseUrlValidation.valid) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid base_url: ${baseUrlValidation.reason}` } });
      return;
    }
    const pinnedIp = baseUrlValidation.resolvedIp!;

    // Resolve tools — either from manual payload or OpenAPI discovery
    let resolvedTools;
    try {
      if (openapi_url) {
        const resolvedOpenapiUrl = openapi_url.startsWith("http")
          ? openapi_url
          : `http://${ip}${openapi_url.startsWith("/") ? "" : "/"}${openapi_url}`;

        const openapiValidation = await validateBackendUrl(resolvedOpenapiUrl, config.allowPrivateIps, config.allowedHosts);
        if (!openapiValidation.valid) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid openapi_url: ${openapiValidation.reason}` } });
          return;
        }

        const openapiHostname = new URL(resolvedOpenapiUrl).hostname;
        resolvedTools = await discoverToolsFromOpenApi({
          openapiUrl: resolvedOpenapiUrl,
          ipPin: { resolvedIp: openapiValidation.resolvedIp!, hostname: openapiHostname },
          includeTags: include_tags,
          excludeOperations: exclude_operations,
        });

        if (resolvedTools.length === 0) {
          res.status(400).json({ error: { code: "DISCOVERY_ERROR", message: "No tools discovered from OpenAPI spec. Check include_tags/exclude_operations filters." } });
          return;
        }
      } else {
        if (!Array.isArray(tools)) {
          res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "'tools' must be an array" } });
          return;
        }
        resolvedTools = tools;
      }

      // Validate resolved tool endpoints for path-traversal segments before registering.
      // This closes the registration-time gap identified in Sprint 2; proxy.ts still
      // catches traversal at runtime as a backstop.
      for (const tool of resolvedTools) {
        if (typeof tool.endpoint === "string") {
          const pathError = validateEndpointPath(tool.endpoint);
          if (pathError) {
            res.status(400).json({
              error: {
                code: "VALIDATION_ERROR",
                message: `Tool "${tool.name}": ${pathError}`,
                request_id: requestId,
              },
            });
            return;
          }
        }
      }

      await registry.register(name, resolvedTools, resolvedHealthUrl, ip, resolvedBaseUrl, pinnedIp, retry_non_safe_methods === true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = openapi_url ? "DISCOVERY_ERROR" : "VALIDATION_ERROR";
      res.status(400).json({ error: { code, message } });
      return;
    }

    log("info", "Client registered", { name, tools_count: resolvedTools.length, source: openapi_url ? "openapi" : "manual" });
    res.status(200).json({
      status: "registered",
      name,
      tools_count: resolvedTools.length,
      source: openapi_url ? "openapi" : "manual",
    });
  });

  app.get("/register/schema", adminAuth, (_req: Request, res: Response) => {
    if (!_resolvedSchema) {
      res.status(503).json({ error: { code: "SCHEMA_UNAVAILABLE", message: "Schema could not be loaded" } });
      return;
    }
    res.setHeader("Content-Type", "application/schema+json");
    res.json(_resolvedSchema);
  });
}

/**
 * Handles the MCP-kind branch of POST /register: validates mcp_url (SSRF + IP
 * pin, same as REST base_url), connects to the upstream to discover its tools,
 * and registers them. Auth (if the upstream requires it) is read from any
 * previously-configured per-client upstream credential, so an operator can
 * configure auth then re-register.
 */
async function handleMcpRegister(req: Request, res: Response, requestId: string | null): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const name = body.name;
  const mcpUrl = body.mcp_url;
  const transportRaw = typeof body.mcp_transport === "string" ? body.mcp_transport : "streamable-http";

  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Missing required field: name", request_id: requestId } });
    return;
  }
  if (typeof mcpUrl !== "string" || (!mcpUrl.startsWith("http://") && !mcpUrl.startsWith("https://"))) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "mcp_url must start with http:// or https://", request_id: requestId } });
    return;
  }
  if (transportRaw !== "streamable-http" && transportRaw !== "sse") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "mcp_transport must be 'streamable-http' or 'sse'", request_id: requestId } });
    return;
  }
  const transport: McpTransport = transportRaw;

  // SSRF validation + IP pin on the MCP endpoint (same posture as REST base_url).
  const validation = await validateBackendUrl(mcpUrl, config.allowPrivateIps, config.allowedHosts);
  if (!validation.valid) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Invalid mcp_url: ${validation.reason}`, request_id: requestId } });
    return;
  }
  const pinnedIp = validation.resolvedIp!;
  const ip = req.socket?.remoteAddress || "127.0.0.1";

  let toolsCount: number;
  try {
    const discovered = await discoverToolsFromMcpServer(
      { name, url: mcpUrl, transport, resolvedIp: pinnedIp, authHeaders: getUpstreamAuthHeaders(name) ?? undefined },
      { timeoutMs: config.toolCallTimeoutMs }
    );
    if (discovered.length === 0) {
      res.status(400).json({ error: { code: "DISCOVERY_ERROR", message: "No tools discovered from MCP upstream", request_id: requestId } });
      return;
    }
    if (discovered.length > config.maxToolsPerClient) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `MCP upstream exposes ${discovered.length} tools, exceeds maximum of ${config.maxToolsPerClient}`, request_id: requestId } });
      return;
    }
    await registry.registerMcp(name, discovered, mcpUrl, transport, ip, pinnedIp);
    toolsCount = discovered.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: { code: "DISCOVERY_ERROR", message, request_id: requestId } });
    return;
  }

  log("info", "MCP upstream registered", { name, tools_count: toolsCount, source: "mcp" });
  res.status(200).json({ status: "registered", name, tools_count: toolsCount, source: "mcp" });
}
