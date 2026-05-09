import { dereference } from "@scalar/openapi-parser";
import type { ErrorObject } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";
import type { OpenAPIV3 } from "openapi-types";
import type { RestToolDefinition } from "./types.js";
import { config } from "./config.js";

const VALID_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export async function discoverToolsFromOpenApi(options: {
  openapiUrl: string;
  ipPin?: { resolvedIp: string; hostname: string };
  includeTags?: string[];
  excludeOperations?: string[];
}): Promise<RestToolDefinition[]> {
  const { openapiUrl, ipPin, includeTags, excludeOperations } = options;

  // 1. Fetch spec — use DNS-pinned URL when ipPin is provided to prevent DNS rebinding
  let fetchUrl = openapiUrl;
  const fetchHeaders: Record<string, string> = {};
  if (ipPin) {
    const parsed = new URL(openapiUrl);
    fetchHeaders["Host"] = ipPin.hostname;
    parsed.hostname = ipPin.resolvedIp;
    fetchUrl = parsed.toString();
  }
  const res = await fetch(fetchUrl, {
    headers: fetchHeaders,
    redirect: "error" as RequestRedirect,
    signal: AbortSignal.timeout(config.openapiDiscoveryTimeoutMs),
  });
  if (!res.ok) throw new Error(`Failed to fetch OpenAPI spec from ${openapiUrl}: ${res.status}`);

  // Limit spec size to 5MB to prevent DoS
  const MAX_SPEC_SIZE = 5 * 1024 * 1024;
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_SPEC_SIZE) {
    throw new Error(`OpenAPI spec too large: ${contentLength} bytes (max ${MAX_SPEC_SIZE})`);
  }

  const text = await res.text();
  if (text.length > MAX_SPEC_SIZE) {
    throw new Error(`OpenAPI spec too large: ${text.length} bytes (max ${MAX_SPEC_SIZE})`);
  }

  // 2. Parse (JSON or YAML). parseYaml and JSON.parse return untyped values;
  //    we pass the result directly to dereference which accepts AnyObject | string.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = parseYaml(text);
  }

  // 2b. Depth cap — reject deeply nested specs before dereference to prevent ReDoS/OOM.
  // Uses iterative BFS (not recursion) to avoid call-stack exhaustion.
  {
    const maxDepth = config.maxJsonDepth;
    const seen = new Set<object>();
    const queue: Array<{ node: object; depth: number }> = [{ node: parsed as object, depth: 0 }];
    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (seen.has(node)) continue;
      seen.add(node);
      if (depth > maxDepth) {
        throw new Error("OPENAPI_TOO_DEEP: OpenAPI spec exceeds maximum nesting depth");
      }
      const values = Array.isArray(node)
        ? (node as unknown[])
        : Object.values(node as Record<string, unknown>);
      for (const child of values) {
        if (child !== null && typeof child === "object") {
          queue.push({ node: child as object, depth: depth + 1 });
        }
      }
    }
  }

  // 3. Dereference. The schema field is typed OpenAPI.Document by @scalar/openapi-parser.
  //    We restrict this codebase to OpenAPI 3.0/3.1 (the most common formats); specs
  //    that deviate to Swagger 2.0 will still work structurally but are not officially supported.
  const { schema, errors } = await dereference(parsed as Record<string, unknown>);
  if (errors?.length) throw new Error(`Invalid OpenAPI spec: ${errors.map((e: ErrorObject) => e.message).join(", ")}`);
  if (!schema?.paths) throw new Error("OpenAPI spec has no paths");

  const doc = schema as unknown as OpenAPIV3.Document;

  // 4. Extract base path
  const serverUrl = doc.servers?.[0]?.url ?? "";
  const basePath = serverUrl.startsWith("/") ? serverUrl.replace(/\/$/, "") : "";

  // 5. Map operations
  const tools: RestToolDefinition[] = [];
  const excludeSet = new Set(excludeOperations ?? []);

  for (const [path, pathItem] of Object.entries(doc.paths as Record<string, OpenAPIV3.PathItemObject>)) {
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, OpenAPIV3.OperationObject>)) {
      if (!VALID_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if ((operation as Record<string, unknown>)["x-internal"]) continue;

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

function buildInputSchema(
  operation: OpenAPIV3.OperationObject,
  pathItem: OpenAPIV3.PathItemObject
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  // Merge path-level and operation-level parameters
  const rawParams: (OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject)[] = [
    ...(pathItem.parameters ?? []),
    ...(operation.parameters ?? []),
  ];

  for (const param of rawParams) {
    // Skip unresolved $ref objects (should not occur post-dereference, but guard defensively)
    if ("$ref" in param) continue;
    const p = param as OpenAPIV3.ParameterObject;
    const schema = p.schema as OpenAPIV3.SchemaObject | undefined;
    const prop: Record<string, unknown> = { type: schema?.type ?? "string" };
    if (p.description) prop.description = p.description;
    if (schema?.enum) prop.enum = schema.enum;
    if (schema?.default !== undefined) prop.default = schema.default;
    if ((schema as Record<string, unknown> | undefined)?.["example"] !== undefined) {
      prop.example = (schema as Record<string, unknown>)["example"];
    }
    properties[p.name] = prop;
    if (p.required || p.in === "path") required.push(p.name);
  }

  // Merge request body
  const requestBody = operation.requestBody;
  const bodySchema =
    requestBody && !("$ref" in requestBody)
      ? (requestBody as OpenAPIV3.RequestBodyObject).content?.["application/json"]?.schema
      : undefined;

  if (bodySchema && !("$ref" in bodySchema)) {
    const bodySchemaObj = bodySchema as OpenAPIV3.SchemaObject;
    if (bodySchemaObj.properties) {
      for (const [key, val] of Object.entries(bodySchemaObj.properties)) {
        properties[key] = val as Record<string, unknown>;
      }
    }
    if (Array.isArray(bodySchemaObj.required)) {
      required.push(...bodySchemaObj.required);
    }
  }

  return {
    type: "object" as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
