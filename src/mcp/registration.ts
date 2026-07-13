import { registry, validateEndpointPath } from "./registry.js";
import { discoverToolsFromOpenApi } from "../discovery/openapi-discovery.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../net/ip-validator.js";
import { log } from "../logger.js";
import { discoverToolsFromMcpServer } from "./mcp-discovery.js";
import { discoverToolsFromGraphQl } from "../discovery/graphql-discovery.js";
import { parseCurlCommand, parsePostmanCollection } from "../discovery/curl-postman-discovery.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { setToolGraphql } from "../proxy/backends.js";
import { getWsProxyTargetDetail } from "../ws-proxy.js";
import type { McpTransport, RestToolDefinition } from "./types.js";
// Bun parses YAML modules at bundle time (native loader, same as JSON) — this
// works identically under `bun src/index.ts` and under `bun build --compile`.
// The previous `readFileSync(resolve(import.meta.dirname, ...))` approach
// broke in standalone-executable mode: `import.meta.dirname` resolves to a
// synthetic $bunfs path there, not a real on-disk directory, so the read
// always threw ENOENT (harmless here — this route degrades to a 503 below).
import openapiSpec from "../openapi.yaml";
import { errorMessage } from "../lib/error-message.js";

/**
 * ws-proxy.ts's upsertWsProxyTarget() rejects a new ws-proxy target whose
 * name collides with an existing client (via registry.getClient), but that
 * check only runs on the ws-proxy side — registry.register()/registerMcp()
 * have no reciprocal check (registry.ts can't import ws-proxy.ts, which
 * already imports registry.ts). Enforce the other direction here instead,
 * in the one place both namespaces are already visible. Without this, a
 * client name colliding with an existing ws-proxy target would silently
 * share that target's circuit breaker (getCircuitBreaker is keyed by name
 * alone) and its key-scope grants (isClientInKeyScope treats the `clients`
 * scope list as covering both namespaces) — cross-feature availability and
 * authorization bleed between two otherwise-unrelated resources.
 */
function wsProxyNameCollision(name: string, requestId: string | null): RegisterOutcome | null {
  if (!getWsProxyTargetDetail(name)) return null;
  return {
    ok: false,
    status: 409,
    body: {
      error: {
        code: "NAME_COLLISION",
        message: `"${name}" is already registered as a WS proxy target`,
        request_id: requestId,
      },
    },
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
type SchemaObject = { [k: string]: JsonValue };

// Cache the resolved schema once at module load time
function resolveRefs(obj: JsonValue, visited: WeakSet<object> = new WeakSet()): JsonValue {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, visited));
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
  const spec = openapiSpec as { components: { schemas: Record<string, SchemaObject> } };
  _schemaComponents = spec.components.schemas;
  _resolvedSchema = resolveRefs(JSON.parse(JSON.stringify(_schemaComponents["RegistrationPayload"]))) as SchemaObject;
} catch (err) {
  log("warn", "Failed to pre-load /register/schema", { error: String(err) });
}

/** The resolved (all `$ref`s inlined) JSON schema for the /register payload, or null if it couldn't be loaded at module init — see the try/catch above. Consumed by GET /register/schema. */
export const resolvedRegistrationSchema: SchemaObject | null = _resolvedSchema;

/**
 * Result of a registration attempt, expressed as the exact HTTP status/body
 * pair the /register route would have sent — this is a pure, non-Express
 * extraction of the route handler bodies (see performRestRegistration /
 * performMcpRegistration below), so callers that aren't HTTP requests (the
 * catalog "install" route) get byte-identical outcomes/error shapes without
 * duplicating any SSRF/validation logic.
 */
export type RegisterOutcome =
  | {
      ok: true;
      status: number;
      body: {
        status: string;
        name: string;
        tools_count: number;
        source: "openapi" | "manual" | "mcp" | "graphql";
        warnings?: string[];
      };
    }
  | { ok: false; status: number; body: { error: { code: string; message: string; request_id?: string | null } } };

/**
 * Cap-check on a resolved tools array, shared between performRestRegistration
 * (only invoked there for the curl/postman-parsed branches — a hand-written
 * 'tools' array is already capped earlier, before this module is reached) and
 * the discovery preview route (POST /admin-api/discovery/preview), which
 * enforces it unconditionally so a preview can never show a tool set that
 * would then be rejected at actual registration time.
 */
export function toolsCountCapError(toolsLength: number, maxToolsPerClient: number): string | null {
  if (toolsLength > maxToolsPerClient) {
    return `Parsed ${toolsLength} tools, exceeds maximum of ${maxToolsPerClient}`;
  }
  return null;
}

/**
 * Validates every tool's endpoint for path-traversal segments. Shared between
 * performRestRegistration and the discovery preview route so a preview can
 * never show tools that would then be rejected at registration time. Closes
 * the registration-time gap identified in Sprint 2; proxy.ts still catches
 * traversal at runtime as a backstop.
 */
export function findToolEndpointError(tools: { name: string; endpoint?: unknown }[]): string | null {
  for (const tool of tools) {
    if (typeof tool.endpoint === "string") {
      const pathError = validateEndpointPath(tool.endpoint);
      if (pathError) return `Tool "${tool.name}": ${pathError}`;
    }
  }
  return null;
}

/**
 * Resolves and SSRF-validates the two backend URLs a REST registration pins
 * itself to — health_url and base_url — returning the derived peer IP, the two
 * absolute URLs, and base_url's pinned resolved IP. base_url defaults to
 * health_url's origin when omitted. Any failing gate (missing peer IP for a
 * relative health_url, a bad base_url scheme, or either URL failing SSRF)
 * returns the exact error RegisterOutcome the inline code did.
 */
async function resolveRestRegistrationTargets(
  health_url: string,
  base_url: string | undefined,
  peerIp: string | undefined,
  requestId: string | null,
): Promise<RegisterOutcome | { ip: string; resolvedHealthUrl: string; resolvedBaseUrl: string; pinnedIp: string }> {
  // Change C — use the true peer address; req.ip follows X-Forwarded-For when
  // TRUST_PROXY is set, which is attacker-controlled.
  if (!health_url.startsWith("http") && !peerIp) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Cannot determine peer IP for relative health_url",
          request_id: requestId,
        },
      },
    };
  }
  const ip = peerIp || "127.0.0.1";

  // Resolve health_url
  const resolvedHealthUrl = health_url.startsWith("http")
    ? health_url
    : `http://${ip}${health_url.startsWith("/") ? "" : "/"}${health_url}`;

  // Validate health_url against SSRF
  const healthValidation = await validateBackendUrl(resolvedHealthUrl, config.allowPrivateIps, config.allowedHosts);
  if (!healthValidation.valid) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: `Invalid health_url: ${healthValidation.reason}` } },
    };
  }

  // Resolve base_url
  let resolvedBaseUrl: string;
  if (base_url) {
    if (!base_url.startsWith("http://") && !base_url.startsWith("https://")) {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "base_url must start with http:// or https://" } },
      };
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
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: `Invalid base_url: ${baseUrlValidation.reason}` } },
    };
  }
  const pinnedIp = baseUrlValidation.resolvedIp;
  return { ip, resolvedHealthUrl, resolvedBaseUrl, pinnedIp };
}

/**
 * Resolves the tool list from whichever discovery source the payload selected —
 * OpenAPI auto-discovery (SSRF-validated + IP-pinned), a cURL paste, a Postman
 * collection, or a hand-written 'tools' array. Returns the resolved tools, or
 * the exact error RegisterOutcome the inline branch did (bad openapi_url, zero
 * OpenAPI tools, a non-array 'tools'). Network/parse throws propagate to the
 * caller's try/catch so the DISCOVERY_ERROR vs VALIDATION_ERROR code selection
 * stays put.
 */
async function resolveRestTools(
  openapi_url: string | undefined,
  ip: string,
  hasCurl: boolean,
  curl_input: string,
  hasPostman: boolean,
  postman_collection: unknown,
  tools: unknown,
  include_tags: string[] | undefined,
  exclude_operations: string[] | undefined,
): Promise<RegisterOutcome | { tools: RestToolDefinition[] }> {
  let resolvedTools;
  if (openapi_url) {
    const resolvedOpenapiUrl = openapi_url.startsWith("http")
      ? openapi_url
      : `http://${ip}${openapi_url.startsWith("/") ? "" : "/"}${openapi_url}`;

    const openapiValidation = await validateBackendUrl(resolvedOpenapiUrl, config.allowPrivateIps, config.allowedHosts);
    if (!openapiValidation.valid) {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: `Invalid openapi_url: ${openapiValidation.reason}` } },
      };
    }

    const openapiHostname = new URL(resolvedOpenapiUrl).hostname;
    resolvedTools = await discoverToolsFromOpenApi({
      openapiUrl: resolvedOpenapiUrl,
      ipPin: { resolvedIp: openapiValidation.resolvedIp, hostname: openapiHostname },
      includeTags: include_tags,
      excludeOperations: exclude_operations,
    });

    if (resolvedTools.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "DISCOVERY_ERROR",
            message: "No tools discovered from OpenAPI spec. Check include_tags/exclude_operations filters.",
          },
        },
      };
    }
  } else if (hasCurl) {
    // Parsing is pure/local (no network access, no SSRF surface) — a parse
    // failure here is a VALIDATION_ERROR (bad input), not a DISCOVERY_ERROR
    // (which the catch block below reserves for openapi_url's network path).
    resolvedTools = parseCurlCommand(curl_input);
  } else if (hasPostman) {
    const collection = typeof postman_collection === "string" ? JSON.parse(postman_collection) : postman_collection;
    resolvedTools = parsePostmanCollection(collection);
  } else {
    if (!Array.isArray(tools)) {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: "'tools' must be an array" } },
      };
    }
    resolvedTools = tools;
  }
  return { tools: resolvedTools };
}

/**
 * Post-processes a resolved REST tool list and writes it to the registry: the
 * curl/postman-only tools-count cap, the per-tool endpoint path-traversal
 * check, then registry.register(). Returns an error RegisterOutcome if a gate
 * fails, or null once the client is registered. registry.register() throws
 * propagate to the caller's try/catch.
 */
async function finalizeRestRegistration(
  name: string,
  resolvedTools: RestToolDefinition[],
  hasCurl: boolean,
  hasPostman: boolean,
  resolvedHealthUrl: string,
  ip: string,
  resolvedBaseUrl: string,
  pinnedIp: string,
  retry_non_safe_methods: unknown,
  requestId: string | null,
): Promise<RegisterOutcome | null> {
  // A curl_input/postman_collection paste can legitimately produce far more
  // tools than a hand-written 'tools' array ever would (Change B above only
  // caps a literal 'tools' array, before either parser has run) — enforce
  // the same cap here for parity with the OpenAPI/MCP/GraphQL branches.
  if (hasCurl || hasPostman) {
    const capError = toolsCountCapError(resolvedTools.length, config.maxToolsPerClient);
    if (capError) {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "VALIDATION_ERROR", message: capError, request_id: requestId } },
      };
    }
  }

  // Validate resolved tool endpoints for path-traversal segments before registering.
  // This closes the registration-time gap identified in Sprint 2; proxy.ts still
  // catches traversal at runtime as a backstop.
  const endpointError = findToolEndpointError(resolvedTools);
  if (endpointError) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: endpointError, request_id: requestId } },
    };
  }

  await registry.register(
    name,
    resolvedTools,
    resolvedHealthUrl,
    ip,
    resolvedBaseUrl,
    pinnedIp,
    retry_non_safe_methods === true,
  );
  return null;
}

/**
 * Pure (non-Express) core of the REST/OpenAPI registration branch — the exact
 * logic that used to live inline in the POST /register handler, unchanged
 * except that every `res.status(x).json(y); return;` became `return {ok:false,
 * status:x, body:y}`. `body` is `Record<string, unknown>` (there's still no
 * schema validation upstream — every field's shape is only as trustworthy as
 * this function's own `typeof` narrowing), so every field read off it below
 * is explicitly type-guarded before use rather than assumed.
 */
export async function performRestRegistration(
  body: Record<string, unknown>,
  peerIp: string | undefined,
  requestId: string | null,
): Promise<RegisterOutcome> {
  const {
    name,
    tools,
    health_url,
    openapi_url,
    include_tags,
    exclude_operations,
    retry_non_safe_methods,
    curl_input,
    postman_collection,
  } = body;

  // Validate required fields
  if (!name || typeof name !== "string" || !health_url || typeof health_url !== "string") {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Missing required fields: name, health_url" } },
    };
  }
  const wsCollision = wsProxyNameCollision(name, requestId);
  if (wsCollision) return wsCollision;

  // base_url is optional, but when present it's later passed to
  // resolveRestRegistrationTargets/URL construction as a string — a wrong
  // type here used to be silently forwarded as `any` and would throw an
  // uncaught TypeError (e.g. `base_url.startsWith` on a number) instead of
  // producing the same VALIDATION_ERROR a malformed base_url string gets
  // below. Reject it up front with the identical message/code.
  if (body.base_url !== undefined && body.base_url !== null && typeof body.base_url !== "string") {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "base_url must start with http:// or https://" } },
    };
  }
  const baseUrl = typeof body.base_url === "string" ? body.base_url : undefined;

  // Exactly one discovery-source field: an explicit 'tools' array, OpenAPI
  // auto-discovery, or one of the two lower-friction alternatives below (a
  // raw cURL paste or a Postman Collection v2.1 export) — both of which parse
  // down into the same 'tools' array shape and are registered exactly like
  // hand-written manual tools (source: "manual").
  const openapiUrl = typeof openapi_url === "string" ? openapi_url : undefined;
  const curlInput = typeof curl_input === "string" ? curl_input : "";
  const includeTagsArr = Array.isArray(include_tags)
    ? include_tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const excludeOperationsArr = Array.isArray(exclude_operations)
    ? exclude_operations.filter((t): t is string => typeof t === "string")
    : undefined;
  const hasTools = tools !== undefined && tools !== null;
  const hasOpenapi = typeof openapiUrl === "string" && openapiUrl.length > 0;
  const hasCurl = curlInput.trim().length > 0;
  const hasPostman = postman_collection !== undefined && postman_collection !== null && postman_collection !== "";
  const providedCount = [hasTools, hasOpenapi, hasCurl, hasPostman].filter(Boolean).length;
  if (providedCount === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Must provide exactly one of 'tools', 'openapi_url', 'curl_input', or 'postman_collection'",
        },
      },
    };
  }
  if (providedCount > 1) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Provide exactly one of 'tools', 'openapi_url', 'curl_input', or 'postman_collection', not several",
        },
      },
    };
  }

  const targets = await resolveRestRegistrationTargets(health_url, baseUrl, peerIp, requestId);
  if ("ok" in targets) return targets;
  const { ip, resolvedHealthUrl, resolvedBaseUrl, pinnedIp } = targets;

  // Resolve tools — either from manual payload or OpenAPI discovery
  let resolvedTools;
  try {
    const toolsResult = await resolveRestTools(
      openapiUrl,
      ip,
      hasCurl,
      curlInput,
      hasPostman,
      postman_collection,
      tools,
      includeTagsArr,
      excludeOperationsArr,
    );
    if ("ok" in toolsResult) return toolsResult;
    resolvedTools = toolsResult.tools;

    const finalizeOutcome = await finalizeRestRegistration(
      name,
      resolvedTools,
      hasCurl,
      hasPostman,
      resolvedHealthUrl,
      ip,
      resolvedBaseUrl,
      pinnedIp,
      retry_non_safe_methods,
      requestId,
    );
    if (finalizeOutcome) return finalizeOutcome;
  } catch (err: unknown) {
    const message = errorMessage(err);
    const code = hasOpenapi ? "DISCOVERY_ERROR" : "VALIDATION_ERROR";
    return { ok: false, status: 400, body: { error: { code, message } } };
  }

  log("info", "Client registered", {
    name,
    tools_count: resolvedTools.length,
    source: hasOpenapi ? "openapi" : "manual",
  });
  return {
    ok: true,
    status: 200,
    body: { status: "registered", name, tools_count: resolvedTools.length, source: hasOpenapi ? "openapi" : "manual" },
  };
}

/**
 * Shared prologue for the single-URL registration branches (MCP, GraphQL):
 * `name` is a non-empty string, it doesn't collide with a WS-proxy target, and
 * body[urlKey] is an http(s) URL. Returns the validated name+url or the exact
 * error RegisterOutcome the two inline copies used to build. (REST is not a
 * consumer — it takes multiple URLs and omits request_id, a different shape.)
 */
function checkNameAndUrl(
  body: Record<string, unknown>,
  urlKey: "mcp_url" | "graphql_url",
  requestId: string | null,
): RegisterOutcome | { name: string; url: string } {
  const name = body.name;
  if (typeof name !== "string" || !name) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Missing required field: name", request_id: requestId } },
    };
  }
  const collision = wsProxyNameCollision(name, requestId);
  if (collision) return collision;
  const url = body[urlKey];
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: `${urlKey} must start with http:// or https://`,
          request_id: requestId,
        },
      },
    };
  }
  return { name, url };
}

/**
 * Shared SSRF-validate + IP-pin step for the single-URL registration branches.
 * Returns the pinned IP + resolved peer IP, or the exact error RegisterOutcome.
 */
async function pinRegistrationUrl(
  url: string,
  urlKey: "mcp_url" | "graphql_url",
  peerIp: string | undefined,
  requestId: string | null,
): Promise<RegisterOutcome | { pinnedIp: string; ip: string }> {
  const validation = await validateBackendUrl(url, config.allowPrivateIps, config.allowedHosts);
  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      body: {
        error: { code: "VALIDATION_ERROR", message: `Invalid ${urlKey}: ${validation.reason}`, request_id: requestId },
      },
    };
  }
  return { pinnedIp: validation.resolvedIp, ip: peerIp || "127.0.0.1" };
}

/**
 * Pure (non-Express) core of the MCP-upstream registration branch: validates
 * mcp_url (SSRF + IP pin, same as REST base_url), connects to the upstream to
 * discover its tools, and registers them. Auth (if the upstream requires it)
 * is read from any previously-configured per-client upstream credential, so
 * an operator can configure auth then re-register.
 */
export async function performMcpRegistration(
  body: Record<string, unknown>,
  peerIp: string | undefined,
  requestId: string | null,
): Promise<RegisterOutcome> {
  const basics = checkNameAndUrl(body, "mcp_url", requestId);
  if ("ok" in basics) return basics;
  const { name, url: mcpUrl } = basics;

  const transportRaw = typeof body.mcp_transport === "string" ? body.mcp_transport : "streamable-http";
  if (transportRaw !== "streamable-http" && transportRaw !== "sse") {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "mcp_transport must be 'streamable-http' or 'sse'",
          request_id: requestId,
        },
      },
    };
  }
  const transport: McpTransport = transportRaw;

  // SSRF validation + IP pin on the MCP endpoint (same posture as REST base_url).
  const pinned = await pinRegistrationUrl(mcpUrl, "mcp_url", peerIp, requestId);
  if ("ok" in pinned) return pinned;
  const { pinnedIp, ip } = pinned;

  let toolsCount: number;
  try {
    const discovered = await discoverToolsFromMcpServer(
      { name, url: mcpUrl, transport, resolvedIp: pinnedIp, authHeaders: getUpstreamAuthHeaders(name) ?? undefined },
      { timeoutMs: config.toolCallTimeoutMs },
    );
    if (discovered.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: { code: "DISCOVERY_ERROR", message: "No tools discovered from MCP upstream", request_id: requestId },
        },
      };
    }
    if (discovered.length > config.maxToolsPerClient) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: `MCP upstream exposes ${discovered.length} tools, exceeds maximum of ${config.maxToolsPerClient}`,
            request_id: requestId,
          },
        },
      };
    }
    await registry.registerMcp(name, discovered, mcpUrl, transport, ip, pinnedIp);
    toolsCount = discovered.length;
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, status: 400, body: { error: { code: "DISCOVERY_ERROR", message, request_id: requestId } } };
  }

  log("info", "MCP upstream registered", { name, tools_count: toolsCount, source: "mcp" });
  return { ok: true, status: 200, body: { status: "registered", name, tools_count: toolsCount, source: "mcp" } };
}

/**
 * Runs GraphQL introspection and registers the discovered fields: one REST tool
 * (method "POST") per query/mutation field plus a persisted tool_graphql row
 * carrying each field's synthesized query. Returns an error RegisterOutcome for
 * a failing gate (zero tools, over the per-client cap) or a network/introspection
 * throw (DISCOVERY_ERROR), or the registered tool count on success.
 */
async function discoverAndRegisterGraphqlTools(
  name: string,
  graphqlUrl: string,
  parsedGraphqlUrl: URL,
  pinnedIp: string,
  ip: string,
  resolvedBaseUrl: string,
  resolvedHealthUrl: string,
  includeMutations: boolean,
  requestId: string | null,
): Promise<RegisterOutcome | { toolsCount: number }> {
  try {
    const discovered = await discoverToolsFromGraphQl({
      graphqlUrl,
      ipPin: { resolvedIp: pinnedIp, hostname: parsedGraphqlUrl.hostname },
      authHeaders: getUpstreamAuthHeaders(name) ?? undefined,
      includeMutations,
    });
    if (discovered.length === 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "DISCOVERY_ERROR",
            message: "No tools discovered from GraphQL endpoint",
            request_id: requestId,
          },
        },
      };
    }
    if (discovered.length > config.maxToolsPerClient) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: `GraphQL schema exposes ${discovered.length} tools, exceeds maximum of ${config.maxToolsPerClient}`,
            request_id: requestId,
          },
        },
      };
    }

    const endpointPath = parsedGraphqlUrl.pathname || "/graphql";
    const mappedTools = discovered.map((d) => ({
      name: d.name,
      method: "POST" as const,
      endpoint: endpointPath,
      description: d.description,
      inputSchema: d.inputSchema,
    }));

    await registry.register(name, mappedTools, resolvedHealthUrl, ip, resolvedBaseUrl, pinnedIp, false);
    for (const d of discovered) {
      setToolGraphql(name, d.name, { enabled: true, query: d.query });
    }
    return { toolsCount: discovered.length };
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, status: 400, body: { error: { code: "DISCOVERY_ERROR", message, request_id: requestId } } };
  }
}

/**
 * Pure (non-Express) core of the GraphQL registration branch: validates
 * graphql_url (SSRF + IP pin, same posture as REST/MCP), runs introspection to
 * discover one tool per query/mutation field, registers them as ordinary REST
 * tools (method "POST", a synthesized query persisted via setToolGraphql), and
 * re-registration naturally drops stale tool_graphql rows because
 * registry.register()'s full-replace semantics delete tool rows no longer
 * present, which cascades (tool_graphql's FK is ON DELETE CASCADE) — no manual
 * cleanup step needed.
 */
export async function performGraphqlRegistration(
  body: Record<string, unknown>,
  peerIp: string | undefined,
  requestId: string | null,
): Promise<RegisterOutcome> {
  const basics = checkNameAndUrl(body, "graphql_url", requestId);
  if ("ok" in basics) return basics;
  const { name, url: graphqlUrl } = basics;

  const pinned = await pinRegistrationUrl(graphqlUrl, "graphql_url", peerIp, requestId);
  if ("ok" in pinned) return pinned;
  const { pinnedIp, ip } = pinned;

  // health_url defaults to graphql_url when omitted — many GraphQL servers
  // reject a bare GET on the operation endpoint (CSRF-prevention plugins,
  // etc.), so this is a real risk of false-positive health failures leading
  // to auto-eviction. Surfaced as a warning rather than silently accepted.
  //
  // A caller-supplied health_url is an independent SSRF surface (the periodic
  // health-check loop will fetch it forever) and must be validated exactly
  // like graphql_url — never trusted just because graphql_url already passed.
  const warnings: string[] = [];
  let resolvedHealthUrl: string;
  if (typeof body.health_url === "string" && body.health_url) {
    const rawHealthUrl: string = body.health_url;
    resolvedHealthUrl = rawHealthUrl.startsWith("http")
      ? rawHealthUrl
      : `http://${ip}${rawHealthUrl.startsWith("/") ? "" : "/"}${rawHealthUrl}`;
    const healthValidation = await validateBackendUrl(resolvedHealthUrl, config.allowPrivateIps, config.allowedHosts);
    if (!healthValidation.valid) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: `Invalid health_url: ${healthValidation.reason}`,
            request_id: requestId,
          },
        },
      };
    }
  } else {
    resolvedHealthUrl = graphqlUrl;
    warnings.push(
      "No health_url provided — defaulting to graphql_url. Many GraphQL servers reject a bare GET on the operation " +
        "endpoint, which can cause false health-check failures and auto-eviction. Supply a dedicated liveness endpoint if available.",
    );
  }

  // graphql_url already passed validateBackendUrl above, so this can't throw
  // — parsed once and reused below instead of re-parsing the same URL three times.
  const parsedGraphqlUrl = new URL(graphqlUrl);
  const resolvedBaseUrl = `${parsedGraphqlUrl.protocol}//${parsedGraphqlUrl.host}`;

  const discovery = await discoverAndRegisterGraphqlTools(
    name,
    graphqlUrl,
    parsedGraphqlUrl,
    pinnedIp,
    ip,
    resolvedBaseUrl,
    resolvedHealthUrl,
    body.include_mutations !== false,
    requestId,
  );
  if ("ok" in discovery) return discovery;
  const toolsCount = discovery.toolsCount;

  log("info", "GraphQL endpoint registered", { name, tools_count: toolsCount, source: "graphql" });
  return {
    ok: true,
    status: 200,
    body: {
      status: "registered",
      name,
      tools_count: toolsCount,
      source: "graphql",
      ...(warnings.length ? { warnings } : {}),
    },
  };
}
