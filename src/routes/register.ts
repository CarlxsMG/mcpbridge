import type { Request, Response, Express } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { registry } from "../registry.js";
import { notifyToolsChanged } from "../mcp-server.js";
import { discoverToolsFromOpenApi } from "../openapi-discovery.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../security/ip-validator.js";
import { adminAuth } from "../middleware/auth.js";
import { rateLimitRegister } from "../middleware/rate-limiter.js";
import { log } from "../logger.js";

// Cache the resolved schema once at module load time
function resolveRefs(obj: any, visited: Set<object> = new Set()): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (visited.has(obj)) return obj["$ref"] ?? obj;
  visited.add(obj);
  if (obj["$ref"]) {
    const refName = obj["$ref"].split("/").pop();
    const refClone = JSON.parse(JSON.stringify(_schemaComponents[refName]));
    return resolveRefs(refClone, visited);
  }
  for (const key of Object.keys(obj)) {
    obj[key] = resolveRefs(obj[key], visited);
  }
  return obj;
}

let _schemaComponents: any;
let _resolvedSchema: any;
try {
  const specPath = resolve(import.meta.dirname, "../openapi.yaml");
  const spec = parse(readFileSync(specPath, "utf-8"));
  _schemaComponents = spec.components.schemas;
  _resolvedSchema = resolveRefs(JSON.parse(JSON.stringify(_schemaComponents.RegistrationPayload)));
} catch (err) {
  log("warn", "Failed to pre-load /register/schema", { error: String(err) });
}

export function registerRoutes(app: Express): void {
  app.post("/register", adminAuth, rateLimitRegister(config.rateLimitRegister), async (req: Request, res: Response) => {
    const { name, tools, health_url, openapi_url, include_tags, exclude_operations } = req.body;

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

    // Extract IP from request
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";

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

        resolvedTools = await discoverToolsFromOpenApi({
          openapiUrl: resolvedOpenapiUrl,
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

      registry.register(name, resolvedTools, resolvedHealthUrl, ip, resolvedBaseUrl, pinnedIp);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = openapi_url ? "DISCOVERY_ERROR" : "VALIDATION_ERROR";
      res.status(400).json({ error: { code, message } });
      return;
    }

    // Notify all connected MCP clients that tools changed
    notifyToolsChanged();

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
