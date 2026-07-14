import { dereference } from "@scalar/openapi-parser";
import type { ErrorObject } from "@scalar/openapi-parser";
import { parse as parseYaml } from "yaml";
import type { OpenAPIV3 } from "openapi-types";
import type { RestToolDefinition } from "../mcp/types.js";
import { config } from "../config.js";
import { makePinnedFetch } from "../net/ip-validator.js";
import { sanitizeToolName, uniqueToolName } from "./tool-naming.js";

const VALID_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export async function discoverToolsFromOpenApi(options: {
  openapiUrl: string;
  ipPin?: { resolvedIp: string; hostname: string };
  includeTags?: string[];
  excludeOperations?: string[];
}): Promise<RestToolDefinition[]> {
  const { openapiUrl, ipPin, includeTags, excludeOperations } = options;

  // 1. Fetch spec — when ipPin is provided, route through the shared DNS-pinned
  //    fetch: it swaps the hostname for the SSRF-validated IP, preserves the
  //    original Host header (host:port, derived from the URL), and refuses
  //    redirects — the single anti-DNS-rebinding primitive also used by the REST
  //    dispatch path (proxy.ts) and the MCP-upstream transport (mcp-upstream.ts).
  const pinnedFetch = ipPin ? makePinnedFetch(new URL(openapiUrl).hostname, ipPin.resolvedIp) : null;
  const fetchInit: RequestInit = {
    redirect: "error" as RequestRedirect,
    signal: AbortSignal.timeout(config.openapiDiscoveryTimeoutMs),
  };
  const res = pinnedFetch ? await pinnedFetch(openapiUrl, fetchInit) : await fetch(openapiUrl, fetchInit);
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

  // 2b. Reject genuine circular references before dereference(): a plain JSON.parse
  // result can never be cyclic (JSON text has no way to express object identity), but
  // the parseYaml fallback above can produce one from a YAML doc using self-referential
  // anchors/aliases. @scalar/openapi-parser's dereference() (step 3 below) does not
  // itself detect cycles — walking one can block the event loop for many seconds,
  // which no JS-level timeout can preempt since it's synchronous CPU-bound work.
  // JSON.stringify's native circular-reference detection is the cheapest reliable way
  // to catch this without hand-rolling ancestor-path tracking; legitimate shared/aliased
  // (but acyclic) sub-structures still stringify fine, so this only rejects true cycles.
  // Matching on `instanceof TypeError` rather than the error message text: engines phrase
  // it differently (Bun/JSC: "cannot serialize cyclic structures", V8: "Converting circular
  // structure to JSON") and message text isn't a stable contract. A TypeError from
  // JSON.stringify on parsed JSON/YAML data has no other realistic cause here — the only
  // other documented case (a BigInt value) can't occur since neither JSON.parse nor the
  // yaml parser ever produce one.
  try {
    JSON.stringify(parsed);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error("OPENAPI_CYCLIC_REFERENCE: OpenAPI spec contains a circular reference", { cause: err });
    }
    throw err;
  }

  // 2c. Depth cap — reject deeply nested specs before dereference to prevent ReDoS/OOM.
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
      const values = Array.isArray(node) ? (node as unknown[]) : Object.values(node as Record<string, unknown>);
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

  // 4. Extract base path. The spec's server URL carries the API's path prefix,
  //    which every operation path is relative to. A relative server URL ("/api/v3")
  //    is used verbatim; an ABSOLUTE one ("https://host/api/v3" — the common real
  //    shape for Petstore/Stripe/GitHub) contributes only its pathname, since its
  //    origin is handled by the client's base_url. Previously the absolute case was
  //    dropped entirely, so every discovered endpoint lost its "/api/v3" prefix and
  //    404'd once proxied.
  const serverUrl = doc.servers?.[0]?.url ?? "";
  let basePath = "";
  if (serverUrl.startsWith("/")) {
    basePath = serverUrl.replace(/\/$/, "");
  } else if (serverUrl) {
    try {
      basePath = new URL(serverUrl).pathname.replace(/\/$/, "");
    } catch {
      basePath = ""; // malformed absolute server URL — no usable base path
    }
  }

  // 5. Map operations
  const tools: RestToolDefinition[] = [];
  const excludeSet = new Set(excludeOperations ?? []);
  const usedNames = new Set<string>();

  for (const [path, pathItem] of Object.entries(doc.paths as Record<string, OpenAPIV3.PathItemObject>)) {
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, OpenAPIV3.OperationObject>)) {
      if (!VALID_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if ((operation as Record<string, unknown>)["x-internal"]) continue;

      // exclude_operations matches the spec's own raw operationId, before any
      // sanitization below — an operator filtering by "deleteEverything"
      // shouldn't have to guess at a normalized form.
      const opId = operation.operationId;
      if (opId && excludeSet.has(opId)) continue;

      if (includeTags?.length) {
        const opTags: string[] = operation.tags ?? [];
        if (!opTags.some((t: string) => includeTags.includes(t))) continue;
      }

      // Build name — operationId is author-supplied and commonly camelCase
      // (e.g. "updatePet"), which the registry's tool-name rule rejects
      // outright (lowercase alphanumeric + hyphen/underscore only). Normalize
      // it the same way a missing operationId already gets normalized by
      // generateToolName, and disambiguate any resulting collision.
      const name = uniqueToolName(sanitizeToolName(opId ?? generateToolName(method, path)), usedNames);

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
  pathItem: OpenAPIV3.PathItemObject,
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
