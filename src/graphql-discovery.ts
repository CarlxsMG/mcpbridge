import { config } from "./config.js";
import { sanitizeToolName, uniqueToolName } from "./tool-naming.js";

/**
 * GraphQL analog of openapi-discovery.ts: point at an endpoint with
 * introspection enabled, get one MCP tool per query/mutation field. No
 * GraphQL library dependency — introspection is a plain POST of the standard
 * introspection query, and the type-to-JSON-Schema mapper below is hand-rolled
 * since only a small, well-known subset of GraphQL's type system needs
 * covering (scalars, enums, input objects, lists, non-null).
 *
 * Reuses the exact same SSRF-safe-fetch technique as OpenAPI discovery
 * (DNS-pinned URL + explicit Host header + redirect:"error" + timeout + size
 * cap) — see discoverToolsFromOpenApi for the sibling implementation.
 */

export interface GraphqlDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Synthesized GraphQL document for this field, persisted via setToolGraphql. */
  query: string;
}

interface GqlTypeRef {
  kind: string;
  name: string | null;
  ofType: GqlTypeRef | null;
}

interface GqlInputValue {
  name: string;
  description: string | null;
  type: GqlTypeRef;
  defaultValue: string | null;
}

interface GqlField {
  name: string;
  description: string | null;
  args: GqlInputValue[];
  type: GqlTypeRef;
}

interface GqlFullType {
  kind: string;
  name: string | null;
  fields: GqlField[] | null;
  inputFields: GqlInputValue[] | null;
  enumValues: { name: string }[] | null;
}

const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      fields(includeDeprecated: false) {
        name
        description
        args { ...InputValue }
        type { ...TypeRef }
      }
      inputFields { ...InputValue }
      enumValues(includeDeprecated: false) { name }
    }
  }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
}
`;

const MAX_SPEC_SIZE = 5 * 1024 * 1024;

/** Unwraps NON_NULL/LIST wrappers down to the named type, tracking whether it's a list and/or non-null. */
function unwrap(t: GqlTypeRef): { named: GqlTypeRef; required: boolean; list: boolean } {
  let cur = t;
  let required = false;
  let list = false;
  if (cur.kind === "NON_NULL") {
    required = true;
    cur = cur.ofType!;
  }
  if (cur.kind === "LIST") {
    list = true;
    cur = cur.ofType!;
    if (cur.kind === "NON_NULL") cur = cur.ofType!;
  }
  return { named: cur, required, list };
}

/** Prints the canonical GraphQL type signature for a variable declaration, e.g. "[ID!]!". */
function printTypeRef(t: GqlTypeRef): string {
  if (t.kind === "NON_NULL") return `${printTypeRef(t.ofType!)}!`;
  if (t.kind === "LIST") return `[${printTypeRef(t.ofType!)}]`;
  return t.name!;
}

function scalarToJsonType(scalarName: string | null): string {
  if (scalarName === "Int" || scalarName === "Float") return "number";
  if (scalarName === "Boolean") return "boolean";
  return "string"; // String, ID, and any custom scalar pass through as a string
}

/** Arg/input type -> JSON Schema. Depth-capped to bound recursive INPUT_OBJECT graphs. */
function typeToJsonSchema(t: GqlTypeRef, typeMap: Map<string, GqlFullType>, depth: number): Record<string, unknown> {
  const { named, list } = unwrap(t);
  if (depth > config.graphqlInputMaxDepth) {
    return { type: "string", description: "(nested input truncated)" };
  }
  let schema: Record<string, unknown>;
  const full = named.name ? typeMap.get(named.name) : undefined;
  if (named.kind === "ENUM" && full?.enumValues) {
    schema = { type: "string", enum: full.enumValues.map((v) => v.name) };
  } else if (named.kind === "INPUT_OBJECT" && full?.inputFields) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of full.inputFields) {
      const { required: fieldRequired } = unwrap(f.type);
      const fieldSchema: Record<string, unknown> = { ...typeToJsonSchema(f.type, typeMap, depth + 1) };
      if (f.description) fieldSchema.description = f.description;
      properties[f.name] = fieldSchema;
      if (fieldRequired && f.defaultValue == null) required.push(f.name);
    }
    schema = { type: "object", properties, ...(required.length ? { required } : {}) };
  } else {
    schema = { type: scalarToJsonType(named.name) };
  }
  return list ? { type: "array", items: schema } : schema;
}

/** Synthesizes a shallow default selection set for an object/interface return type. Unions/deep nesting fall back to `{ __typename }`. */
function buildSelectionSet(t: GqlTypeRef, typeMap: Map<string, GqlFullType>, depth: number): string {
  const { named } = unwrap(t);
  const full = named.name ? typeMap.get(named.name) : undefined;
  if (!full || named.kind === "SCALAR" || named.kind === "ENUM") return "";
  if (named.kind === "UNION" || depth > config.graphqlSelectionMaxDepth) return "{ __typename }";

  const picks: string[] = [];
  for (const f of full.fields ?? []) {
    // Can't auto-satisfy a sub-field that itself requires args with no default.
    if (f.args.some((a) => unwrap(a.type).required && a.defaultValue == null)) continue;
    const sub = unwrap(f.type);
    const subFull = sub.named.name ? typeMap.get(sub.named.name) : undefined;
    if (!subFull || sub.named.kind === "SCALAR" || sub.named.kind === "ENUM") {
      picks.push(f.name);
    } else if (depth < config.graphqlSelectionMaxDepth) {
      const nested = buildSelectionSet(f.type, typeMap, depth + 1);
      if (nested) picks.push(`${f.name} ${nested}`);
    }
  }
  return `{ ${picks.length ? picks.join(" ") : "__typename"} }`;
}

function synthesizeQuery(opKind: "query" | "mutation", field: GqlField, typeMap: Map<string, GqlFullType>, toolName: string): string {
  const varDecls = field.args.map((a) => `$${a.name}: ${printTypeRef(a.type)}`).join(", ");
  const callArgs = field.args.map((a) => `${a.name}: $${a.name}`).join(", ");
  const selection = buildSelectionSet(field.type, typeMap, 0);
  return `${opKind} ${toolName}${varDecls ? `(${varDecls})` : ""} { ${field.name}${callArgs ? `(${callArgs})` : ""}${selection ? ` ${selection}` : ""} }`;
}

function fieldToTool(opKind: "query" | "mutation", field: GqlField, typeMap: Map<string, GqlFullType>, usedNames: Set<string>): GraphqlDiscoveredTool {
  // Prefer the bare field name; fall back to an opKind-prefixed variant on
  // collision (e.g. a query and mutation both named "pet") before falling
  // further back to uniqueToolName's numeric-suffix disambiguation — shared
  // with openapi-discovery.ts so both sources get the same length-safe,
  // termination-guaranteed collision handling (see src/tool-naming.ts).
  const base = sanitizeToolName(field.name);
  const candidate = usedNames.has(base) ? sanitizeToolName(`${opKind}_${field.name}`) : base;
  const name = uniqueToolName(candidate, usedNames);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of field.args) {
    const { required: argRequired } = unwrap(arg.type);
    const argSchema: Record<string, unknown> = { ...typeToJsonSchema(arg.type, typeMap, 0) };
    if (arg.description) argSchema.description = arg.description;
    properties[arg.name] = argSchema;
    if (argRequired && arg.defaultValue == null) required.push(arg.name);
  }

  return {
    name,
    description: field.description || `GraphQL ${opKind} "${field.name}"`,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    query: synthesizeQuery(opKind, field, typeMap, name),
  };
}

export async function discoverToolsFromGraphQl(options: {
  graphqlUrl: string;
  ipPin?: { resolvedIp: string; hostname: string };
  authHeaders?: Record<string, string>;
  includeMutations?: boolean;
}): Promise<GraphqlDiscoveredTool[]> {
  const { graphqlUrl, ipPin, authHeaders, includeMutations = true } = options;

  // 1. Fetch — DNS-pinned URL when ipPin is provided, exactly like OpenAPI discovery.
  let fetchUrl = graphqlUrl;
  const fetchHeaders: Record<string, string> = { "Content-Type": "application/json", ...(authHeaders ?? {}) };
  if (ipPin) {
    const parsed = new URL(graphqlUrl);
    fetchHeaders["Host"] = ipPin.hostname;
    parsed.hostname = ipPin.resolvedIp;
    fetchUrl = parsed.toString();
  }
  const res = await fetch(fetchUrl, {
    method: "POST",
    headers: fetchHeaders,
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    redirect: "error" as RequestRedirect,
    signal: AbortSignal.timeout(config.graphqlDiscoveryTimeoutMs),
  });
  if (!res.ok) throw new Error(`Failed to fetch GraphQL introspection from ${graphqlUrl}: ${res.status}`);

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_SPEC_SIZE) {
    throw new Error(`GraphQL introspection response too large: ${contentLength} bytes (max ${MAX_SPEC_SIZE})`);
  }
  const text = await res.text();
  if (text.length > MAX_SPEC_SIZE) {
    throw new Error(`GraphQL introspection response too large: ${text.length} bytes (max ${MAX_SPEC_SIZE})`);
  }

  const json = JSON.parse(text) as {
    errors?: { message: string }[];
    data?: { __schema?: { queryType?: { name: string } | null; mutationType?: { name: string } | null; types?: GqlFullType[] } };
  };

  // Defensive cyclic-reference trap — a fresh JSON.parse result can't actually
  // be cyclic, but this mirrors openapi-discovery.ts's paranoia at negligible cost.
  try {
    JSON.stringify(json);
  } catch (err) {
    if (err instanceof TypeError) throw new Error("GRAPHQL_CYCLIC_REFERENCE: introspection response contains a circular reference");
    throw err;
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL introspection returned errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  const schema = json.data?.__schema;
  if (!schema) {
    throw new Error("GRAPHQL_INTROSPECTION_DISABLED: introspection is disabled or unsupported at this endpoint");
  }

  const types = schema.types ?? [];
  if (types.length > config.graphqlMaxTypes) {
    throw new Error(`GRAPHQL_TOO_MANY_TYPES: schema exposes ${types.length} types, exceeds maximum of ${config.graphqlMaxTypes}`);
  }
  const typeMap = new Map<string, GqlFullType>(types.filter((t) => t.name).map((t) => [t.name!, t]));

  const tools: GraphqlDiscoveredTool[] = [];
  const usedNames = new Set<string>();

  const queryType = schema.queryType?.name ? typeMap.get(schema.queryType.name) : undefined;
  for (const field of queryType?.fields ?? []) {
    tools.push(fieldToTool("query", field, typeMap, usedNames));
  }

  if (includeMutations) {
    const mutationType = schema.mutationType?.name ? typeMap.get(schema.mutationType.name) : undefined;
    for (const field of mutationType?.fields ?? []) {
      tools.push(fieldToTool("mutation", field, typeMap, usedNames));
    }
  }

  return tools;
}
