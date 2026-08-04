import { isDeleting } from "../mcp/registry.js";
import { config } from "../config.js";
import { isRawIpLiteral, refreshPinIfStale, makePinnedFetch } from "../net/ip-validator.js";
import type { PinnedIp, PinnedFetch } from "../net/ip-validator.js";
import { incInflight, decInflight, type LbChoice } from "../tool-policies/load-balancer.js";
import { getToolTransform, applyOps } from "./transform.js";
import { getToolGraphql } from "./backends.js";
import { getOAuthBearer } from "../backend-auth/oauth.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { getRedactionPaths } from "../content-filtering/redaction.js";
import { decideSecondary } from "../tool-policies/canary.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolResult } from "./gates.js";
import { getOrCompile } from "./schema-validator.js";
import { errorMessage } from "../lib/error-message.js";

// ===========================================================================
// Stage 2 of the REST dispatch machine: turning a validated tool call into a
// concrete, SSRF-pinned HTTP request.
//
// Split out of dispatch-rest.ts, which had grown to ~1120 lines covering three
// distinct stages. This module owns everything up to "we have a fetch to make":
// path-param substitution and traversal rejection, Ajv arg validation, the
// declarative request transform, target selection's IP pinning (LB member /
// canary secondary / TTL-refreshed primary), and header/body/auth assembly.
//
// It also owns the two pieces of module-level state that only make sense here:
// the pinned-IP cache (written by resolvePinnedTarget) and the per-client
// in-flight AbortController registry (opened here, released by the caller's
// finally). Keeping them next to their only writers is the point of the split —
// they were previously separated from their use by 200 lines of routing logic.
// ===========================================================================
// ---------------------------------------------------------------------------
// TTL-based pinned IP cache — module-level Map keyed on client name
// ---------------------------------------------------------------------------
const pinnedIpCache = new Map<string, PinnedIp>();

// Track in-flight requests per client for cancellation
const inflightControllers = new Map<string, Set<AbortController>>();

function trackRequest(clientName: string): AbortController {
  const controller = new AbortController();
  if (!inflightControllers.has(clientName)) {
    inflightControllers.set(clientName, new Set());
  }
  inflightControllers.get(clientName)!.add(controller);
  return controller;
}

export function untrackRequest(clientName: string, controller: AbortController): void {
  inflightControllers.get(clientName)?.delete(controller);
}

export function abortClientRequests(clientName: string): void {
  const controllers = inflightControllers.get(clientName);
  if (controllers) {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
    controllers.clear();
  }
}

/**
 * Drops the cached pinned IP for a client so the next dispatch re-seeds it from
 * the registry's current `resolved_ip`. The registry calls this when a client is
 * re-registered (its backend — and thus validated IP — may have changed) or torn
 * down; without it a re-registration is invisible to this cache until
 * IP_PIN_TTL_MS lapses, so requests keep routing to the *previous* backend's IP
 * while carrying the new hostname. Not an SSRF hole (both IPs passed
 * validateBackendUrl), but stale routing — this closes that window immediately.
 */
export function invalidatePinnedIp(clientName: string): void {
  pinnedIpCache.delete(clientName);
}

/** Stage-2 built request returned by buildRestRequest (pinned fetch + URL/body + auth + response config). */
export interface RestRequest {
  remainingArgs: Record<string, unknown>;
  /** Only the args routed to the query string (in:query, or the GET/DELETE default) — used to rebuild the query for pagination follow-ups without leaking header/cookie params into the URL. */
  queryParams: URLSearchParams;
  resolvedPath: string;
  transformCfg: ReturnType<typeof getToolTransform>;
  targetBaseUrl: string;
  originalHost: string;
  pinnedFetch: PinnedFetch;
  url: string;
  method: string;
  body: string | undefined;
  upstreamAuthHeaders: Record<string, string>;
  /** OpenAPI in:header / in:cookie params for this call, already forbidden-header-filtered. Lowest header precedence. */
  paramHeaders: Record<string, string>;
  redactionPaths: ReturnType<typeof getRedactionPaths>;
  /** True iff this tool is GraphQL-backed — gates the 200-with-errors failure detection in stage 3 (non-GraphQL tools skip it). */
  graphqlEnabled: boolean;
  reqController: AbortController;
}

/**
 * Stage 2 of dispatchRestToolCall — request building + SSRF IP pinning. Substitutes path params
 * (rejecting post-substitution ".."/"." traversal — Fix 2), validates args via Ajv, applies the
 * declarative request transform, resolves the pinned backend IP (LB member / canary secondary /
 * TTL-refreshed primary), and constructs the pinned fetch + URL/query-or-body + upstream auth
 * (incl. OAuth2 bearer) + redaction paths. Opens in-flight tracking (reqController / LB inflight)
 * that dispatchRestToolCall's finally later releases. Returns a ToolResult for the traversal / Ajv /
 * pin-refresh / deleting early-return cases, otherwise the built-request bundle.
 */
export async function buildRestRequest(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  lbChoice: LbChoice | null,
  route: ReturnType<typeof decideSecondary>,
  lbKey: string | undefined,
): Promise<ToolResult | RestRequest> {
  // Build URL with path param substitution. Consumed path-param names are
  // tracked (not deleted yet) so the Ajv validation below still sees them —
  // openapi-discovery.ts's buildInputSchema always marks a path-in parameter
  // as required in the generated inputSchema, so validating the post-deletion
  // object would always fail with "missing required property" even when the
  // caller correctly supplied it. Deletion happens after validation instead.
  let remainingArgs = { ...args };
  const consumedPathParams = new Set<string>();
  const resolvedPath = tool.endpoint.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, paramName) => {
    const value = remainingArgs[paramName];
    if (value !== undefined) {
      consumedPathParams.add(paramName);
      return encodeURIComponent(String(value));
    }
    return `:${paramName}`;
  });

  // Fix 2 — Path traversal rejection post-substitution.
  // Check the resolved path segments for ".." or "." after decoding.
  // This catches endpoint templates that themselves contain traversal segments
  // (e.g. "/users/:id/../admin") since encodeURIComponent never encodes "/".
  // Note: encodeURIComponent applied to arg values cannot introduce "/" so a user
  // supplying id="../admin" produces the safe literal segment "..%2Fadmin" —
  // the real threat is the operator-supplied template containing ".." directly.
  {
    const pathToCheck = resolvedPath.split("?")[0]; // strip any inline query string
    const segments = pathToCheck.split("/");
    for (const seg of segments) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        decoded = seg;
      }
      if (decoded === ".." || decoded === ".") {
        return toolResult("Tool endpoint resolved to invalid path", { isError: true });
      }
    }
  }

  // Validate args against inputSchema via Ajv (handles enum, format, null, nested objects, etc.)
  // removeAdditional:"all" on the Ajv instance means unknown keys are stripped from remainingArgs.
  // Consumed path params are still present here (see above) so a schema that requires them
  // validates correctly against what the caller actually supplied.
  {
    const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
    const valid = validate(remainingArgs);
    if (!valid) {
      const firstError = validate.errors?.[0];
      return toolResult(
        `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
        { isError: true },
      );
    }
  }

  // Now that validation has run against the caller's full args, strip the
  // consumed path params so they don't leak into the query string / request body.
  for (const name of consumedPathParams) delete remainingArgs[name];

  // Declarative request transform — runs AFTER Ajv strip so an injected field
  // the MCP inputSchema doesn't declare still reaches the backend.
  const transformCfg = getToolTransform(client.name, tool.name);
  if (transformCfg?.enabled && transformCfg.request.length > 0) {
    remainingArgs = applyOps(remainingArgs, transformCfg.request) as Record<string, unknown>;
  }

  // GraphQL-backed tool — the request body becomes a { query, variables } envelope
  // (built in the body step below) with the args as variables.
  const graphqlCfg = getToolGraphql(client.name, tool.name);

  // DNS-rebinding-safe target resolution: the base URL (primary / LB member /
  // canary secondary), the SSRF-pinned IP, and the pinned fetch bound to them.
  const target = await resolvePinnedTarget(client, lbChoice, route, resolvedPath);
  if ("content" in target) return target;
  const { targetBaseUrl, originalHost, pinnedFetch } = target;
  let url = target.url;

  const method = tool.method.toUpperCase();
  let body: string | undefined;

  if (isDeleting(client.name)) {
    return toolResult("Client is being unregistered", { isError: true });
  }

  const reqController = trackRequest(client.name);
  if (lbKey) incInflight(lbKey);

  // Everything from here to the return below runs after trackRequest/incInflight
  // have already registered this request, but before dispatchRestToolCall's own
  // try/finally (which owns the paired untrackRequest/decInflight) starts — that
  // try only wraps the *result* of this function, not its construction. A throw
  // in this window (e.g. getUpstreamAuthHeaders/getOAuthBearer hitting an
  // unguarded DB query) would otherwise leak the inflightControllers entry and
  // the LB in-flight counter forever. Release locally and rethrow so the error
  // still propagates exactly as before.
  // Route each remaining arg to its OpenAPI-declared location. Path params were
  // already substituted into the endpoint and removed above; anything without an
  // explicit location defaults to the query string for GET/DELETE (no body) and
  // the JSON body for POST/PUT/PATCH. This is the fix for in:query/header/cookie
  // params on body methods previously landing in the JSON body instead of the URL.
  const isBodyMethod = method !== "GET" && method !== "DELETE";
  // Header params the UNTRUSTED MCP caller may never set: host/content-* break
  // the pinned-Host SSRF invariant or the JSON framing; authorization/
  // proxy-authorization/cookie would let the caller speak auth to the backend —
  // but the gateway is a credential broker, callers don't get to.
  const FORBIDDEN_PARAM_HEADERS = new Set([
    "host",
    "content-length",
    "content-type",
    "authorization",
    "proxy-authorization",
    "cookie",
  ]);
  // Cookie-octet per RFC 6265 excludes these; a caller value carrying one could
  // inject an extra cookie (;), split the header (CR/LF), or smuggle via , — so
  // reject the call rather than pass it through.
  const UNSAFE_COOKIE_CHAR = /[;,\s"\\]/;
  // Null-prototype: both maps are keyed by tool-call argument names, which the
  // caller controls. With a plain `{}`, an argument literally named `__proto__`
  // would be swallowed by the prototype setter instead of being sent, and an
  // argument named `constructor` would collide with an inherited member.
  const paramHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
  const cookiePairs: string[] = [];
  try {
    const queryParams = new URLSearchParams();
    const bodyArgs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(remainingArgs)) {
      const loc = tool.paramLocations?.[key] ?? (isBodyMethod ? "body" : "query");
      if (loc === "header") {
        if (!FORBIDDEN_PARAM_HEADERS.has(key.toLowerCase())) paramHeaders[key] = String(value);
      } else if (loc === "cookie") {
        const cookieValue = String(value);
        if (UNSAFE_COOKIE_CHAR.test(cookieValue)) {
          // Release the trackRequest/incInflight bookkeeping this branch skips
          // (mirrors the catch below) before the fail-closed early return.
          untrackRequest(client.name, reqController);
          if (lbKey) decInflight(lbKey);
          return toolResult(`Cookie parameter '${key}' contains a disallowed character`, { isError: true });
        }
        cookiePairs.push(`${key}=${cookieValue}`);
      } else if (loc === "query") {
        queryParams.append(key, String(value));
      } else {
        bodyArgs[key] = value;
      }
    }
    const queryString = queryParams.toString();
    if (queryString) url = `${url}${url.includes("?") ? "&" : "?"}${queryString}`;
    if (cookiePairs.length > 0) paramHeaders["Cookie"] = cookiePairs.join("; ");

    if (graphqlCfg?.enabled) {
      // GraphQL tools carry no path/query params — all args are variables.
      body = JSON.stringify({ query: graphqlCfg.query, variables: remainingArgs });
    } else if (isBodyMethod) {
      body = JSON.stringify(bodyArgs);
    }

    // Inject per-client upstream credentials (decrypted at call time). Spread
    // first so the pinned Host and Content-Type set below always take precedence.
    const upstreamAuthHeaders: Record<string, string> = { ...(getUpstreamAuthHeaders(client.name) ?? {}) };
    // Outbound OAuth2 client-credentials — mint/reuse a short-lived token and inject
    // it as a Bearer (the MCP caller never sees the real client secret).
    const oauthBearer = await getOAuthBearer(client.name);
    if (oauthBearer) upstreamAuthHeaders.Authorization = `Bearer ${oauthBearer}`;

    // Defense in depth beyond the static set above: drop any caller-supplied
    // header param that collides case-insensitively with a gateway-managed auth
    // header (covers custom header-name auth, e.g. X-Api-Key). Headers merge
    // case-insensitively by APPENDING, so a lowercase `authorization` param would
    // otherwise become `caller-value, Bearer <secret>` and hand the caller
    // control of the credential on any first-token-wins backend.
    const managedHeaderNames = new Set(Object.keys(upstreamAuthHeaders).map((k) => k.toLowerCase()));
    for (const name of Object.keys(paramHeaders)) {
      if (managedHeaderNames.has(name.toLowerCase())) delete paramHeaders[name];
    }

    // Response redaction paths for this tool (applied to JSON responses below).
    const redactionPaths = getRedactionPaths(client.name, tool.name);
    return {
      remainingArgs,
      queryParams,
      resolvedPath,
      transformCfg,
      targetBaseUrl,
      originalHost,
      pinnedFetch,
      url,
      method,
      body,
      upstreamAuthHeaders,
      paramHeaders,
      redactionPaths,
      graphqlEnabled: graphqlCfg?.enabled ?? false,
      reqController,
    };
  } catch (err) {
    untrackRequest(client.name, reqController);
    if (lbKey) decInflight(lbKey);
    throw err;
  }
}

/**
 * DNS-rebinding-safe outbound-target resolution — kept as one unit so the SSRF
 * pin/Host invariant lives in a single place. Picks the base URL (primary / LB
 * member / config-time-pinned canary secondary), resolves the IP to pin, and
 * builds the shared pinned fetch (which swaps the hostname to `pinIp` at fetch
 * time, sets the Host header, and refuses redirects). For the primary hostname
 * it re-pins via the TTL cache to mitigate IP-pin TOCTOU; LB members and canary
 * secondaries carry a config-time-validated IP used directly. Returns a
 * ToolResult only for the fail-closed case where a primary hostname now
 * resolves to a private IP.
 */
async function resolvePinnedTarget(
  client: RegisteredClient,
  lbChoice: LbChoice | null,
  route: ReturnType<typeof decideSecondary>,
  resolvedPath: string,
): Promise<
  | ToolResult
  | { targetBaseUrl: string; originalHost: string; pinnedFetch: ReturnType<typeof makePinnedFetch>; url: string }
> {
  const targetBaseUrl = lbChoice ? lbChoice.baseUrl : route.useSecondary ? route.cfg.secondaryBaseUrl : client.base_url;
  const parsedBase = new URL(`${targetBaseUrl}${resolvedPath}`);
  const hostname = parsedBase.hostname;

  let pinIp: string;
  if (lbChoice) {
    pinIp = lbChoice.resolvedIp;
  } else if (route.useSecondary) {
    pinIp = route.cfg.secondaryResolvedIp;
  } else {
    // Seed the pin cache from the registry value on first access.
    if (!pinnedIpCache.has(client.name)) {
      pinnedIpCache.set(client.name, { ip: client.resolved_ip, resolvedAt: Date.now() });
    }
    let pin = pinnedIpCache.get(client.name)!;
    // Only attempt re-resolution for hostnames (not raw IP literals).
    if (!isRawIpLiteral(hostname)) {
      try {
        // Thread the same allow-private / allowed-host policy that admitted this
        // backend at registration — otherwise a hostname-registered private
        // backend (ALLOW_PRIVATE_IPS=true) would be wrongly rejected 5 minutes
        // after registration when its pin first goes stale (Fix 8).
        pin = await refreshPinIfStale(hostname, pin, Date.now(), config.allowPrivateIps, config.allowedHosts);
        pinnedIpCache.set(client.name, pin);
      } catch (err) {
        return toolResult(`Backend hostname now resolves to private IP: ${errorMessage(err)}`, { isError: true });
      }
    }
    pinIp = pin.ip;
  }

  return {
    targetBaseUrl,
    originalHost: parsedBase.host,
    pinnedFetch: makePinnedFetch(hostname, pinIp),
    url: parsedBase.toString(),
  };
}
