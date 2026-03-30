import type { Request, Response, Express } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { registry } from "../registry.js";
import { notifyToolsChanged } from "../mcp-server.js";
import { discoverToolsFromOpenApi } from "../openapi-discovery.js";

export function registerRoutes(app: Express): void {
  app.post("/register", async (req: Request, res: Response) => {
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

    // Resolve tools — either from manual payload or OpenAPI discovery
    let resolvedTools;
    try {
      if (openapi_url) {
        const resolvedOpenapiUrl = openapi_url.startsWith("http")
          ? openapi_url
          : `http://${ip}${openapi_url.startsWith("/") ? "" : "/"}${openapi_url}`;

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

      registry.register(name, resolvedTools, resolvedHealthUrl, ip);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = openapi_url ? "DISCOVERY_ERROR" : "VALIDATION_ERROR";
      res.status(400).json({ error: { code, message } });
      return;
    }

    // Notify all connected MCP clients that tools changed
    notifyToolsChanged();

    res.status(200).json({
      status: "registered",
      name,
      tools_count: resolvedTools.length,
      source: openapi_url ? "openapi" : "manual",
    });
  });

  app.get("/register/schema", (_req: Request, res: Response) => {
    const specPath = resolve(import.meta.dirname, "../openapi.yaml");
    const spec = parse(readFileSync(specPath, "utf-8"));
    const schemas = spec.components.schemas;

    // Deep clone and resolve $ref pointers
    const resolved = JSON.parse(JSON.stringify(schemas.RegistrationPayload));

    function resolveRefs(obj: any): any {
      if (obj === null || typeof obj !== "object") return obj;
      if (obj["$ref"]) {
        const refName = obj["$ref"].split("/").pop();
        return resolveRefs(JSON.parse(JSON.stringify(schemas[refName])));
      }
      for (const key of Object.keys(obj)) {
        obj[key] = resolveRefs(obj[key]);
      }
      return obj;
    }

    resolveRefs(resolved);
    res.setHeader("Content-Type", "application/schema+json");
    res.json(resolved);
  });
}
