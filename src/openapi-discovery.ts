import { dereference } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";
import type { RestToolDefinition } from "./types.js";
import { config } from "./config.js";

const VALID_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export async function discoverToolsFromOpenApi(options: {
  openapiUrl: string;
  includeTags?: string[];
  excludeOperations?: string[];
}): Promise<RestToolDefinition[]> {
  const { openapiUrl, includeTags, excludeOperations } = options;

  // 1. Fetch spec
  const res = await fetch(openapiUrl, { signal: AbortSignal.timeout(config.openapiDiscoveryTimeoutMs) });
  if (!res.ok) throw new Error(`Failed to fetch OpenAPI spec from ${openapiUrl}: ${res.status}`);
  const text = await res.text();

  // 2. Parse (JSON or YAML)
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = parseYaml(text);
  }

  // 3. Dereference
  const { schema, errors } = await dereference(parsed);
  if (errors?.length) throw new Error(`Invalid OpenAPI spec: ${errors.map((e: any) => e.message).join(", ")}`);
  if (!schema?.paths) throw new Error("OpenAPI spec has no paths");

  // 4. Extract base path
  const serverUrl = (schema as any).servers?.[0]?.url ?? "";
  const basePath = serverUrl.startsWith("/") ? serverUrl.replace(/\/$/, "") : "";

  // 5. Map operations
  const tools: RestToolDefinition[] = [];
  const excludeSet = new Set(excludeOperations ?? []);

  for (const [path, pathItem] of Object.entries((schema as any).paths as Record<string, any>)) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      if (!VALID_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (operation["x-internal"]) continue;

      const opId = operation.operationId;
      if (opId && excludeSet.has(opId)) continue;

      if (includeTags?.length) {
        const opTags: string[] = operation.tags ?? [];
        if (!opTags.some((t: string) => includeTags.includes(t))) continue;
      }

      // Build name
      const name = opId ?? generateToolName(method, path);

      // Build endpoint (convert {param} to :param)
      const endpoint = basePath + path.replace(/\{([^}]+)\}/g, ":$1");

      // Build description
      const description = operation.summary || operation.description || "No description";

      // Build inputSchema
      const inputSchema = buildInputSchema(operation, pathItem);

      tools.push({
        name,
        method: method.toUpperCase() as RestToolDefinition["method"],
        endpoint,
        description,
        inputSchema,
      });
    }
  }

  return tools;
}

function generateToolName(method: string, path: string): string {
  const segments = path
    .replace(/\{([^}]+)\}/g, "by_$1")
    .split("/")
    .filter(Boolean);
  return `${method}_${segments.join("_")}`.toLowerCase();
}

function buildInputSchema(operation: any, pathItem: any): Record<string, unknown> {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  // Merge path-level and operation-level parameters
  const params: any[] = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];

  for (const param of params) {
    const prop: Record<string, any> = { type: param.schema?.type ?? "string" };
    if (param.description) prop.description = param.description;
    if (param.schema?.enum) prop.enum = param.schema.enum;
    if (param.schema?.default !== undefined) prop.default = param.schema.default;
    if (param.schema?.example !== undefined) prop.example = param.schema.example;
    properties[param.name] = prop;
    if (param.required || param.in === "path") required.push(param.name);
  }

  // Merge request body
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema?.properties) {
    for (const [key, val] of Object.entries(bodySchema.properties as Record<string, any>)) {
      properties[key] = val;
    }
    if (Array.isArray(bodySchema.required)) {
      required.push(...bodySchema.required);
    }
  }

  return {
    type: "object" as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
