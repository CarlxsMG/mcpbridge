import { isDeleting } from "../mcp/registry.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { isRawIpLiteral, refreshPinIfStale, makePinnedFetch } from "../net/ip-validator.js";
import type { PinnedIp, PinnedFetch } from "../net/ip-validator.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import {
  recordToolCall,
  proxyBodyCapRejections,
  proxyRetryAttempts,
  proxyRequestDuration,
  cacheEvents,
  lbRequests,
} from "../observability/metrics.js";
import { getToolCacheConfig, cacheSet } from "../tool-policies/response-cache.js";
import {
  getLb,
  selectTarget,
  markTargetUp,
  markTargetDown,
  incInflight,
  decInflight,
  type LbChoice,
} from "../tool-policies/load-balancer.js";
import { getPaginationConfig } from "../tool-policies/pagination.js";
import { fetchAllPages } from "./pagination.js";
import { parseRetryAfter, httpStatusClass, readBodyWithCap } from "./http-util.js";
import { getStreamingConfig, parseStream } from "./streaming.js";
import { getToolTransform, applyOps } from "./transform.js";
import { getToolMock } from "../tool-meta/tool-mock.js";
import { outboundTraceHeaders } from "../observability/trace-context.js";
import { getToolGraphql, getToolWs } from "./backends.js";
import { getOAuthBearer } from "../backend-auth/oauth.js";
import { resolveMcpKeyByToken } from "../security/mcp-key-store.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { recordUsage } from "../observability/usage.js";
import { getRedactionPaths, applyRedaction, stripInjectedCredentials } from "../content-filtering/redaction.js";
import { getGuardrails, applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import { getCanary, decideSecondary } from "../tool-policies/canary.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolResult } from "./gates.js";
import { getOrCompile } from "./schema-validator.js";
import { dispatchWsToolCall } from "./dispatch-ws.js";
import { dispatchMcpToolCall } from "./dispatch-mcp.js";
import { errorMessage } from "../lib/error-message.js";
import type { ToolCallOpts } from "./proxy.js";

// ===========================================================================
// REST dispatch machine — the third and largest of the three transport
// dispatchers (siblings dispatch-mcp.ts / dispatch-ws.ts handle the other two).
// proxy.ts's dispatchToolCall runs the transport-agnostic gate pipeline and
// then hands off to dispatchRestToolCall below, which owns breaker/LB/canary
// routing (stage 1, including the early MCP/WS-kind hand-offs), SSRF-pinned
// request building (stage 2), and success-response processing (stage 3), plus
// the retry loop and the per-client in-flight/abort + pinned-IP bookkeeping.
// `ToolCallOpts` still lives in proxy.ts (the shared public entry-point type);
// importing it back here is the same intentional cycle dispatch-mcp/ws use.
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

function untrackRequest(clientName: string, controller: AbortController): void {
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

/** Stage-1 routing decision returned by resolveRestRouting (breaker/LB/canary + outcome recorders). */
interface RestRouting {
  breaker: ReturnType<typeof getCircuitBreaker>;
  effectiveTimeout: number;
  route: ReturnType<typeof decideSecondary>;
  lbChoice: LbChoice | null;
  lbKey: string | undefined;
  recordBreakerSuccess: () => void;
  recordBreakerFailure: () => void;
}

/** Stage-2 built request returned by buildRestRequest (pinned fetch + URL/body + auth + response config). */
interface RestRequest {
  remainingArgs: Record<string, unknown>;
  resolvedPath: string;
  transformCfg: ReturnType<typeof getToolTransform>;
  targetBaseUrl: string;
  originalHost: string;
  pinnedFetch: PinnedFetch;
  url: string;
  method: string;
  body: string | undefined;
  upstreamAuthHeaders: Record<string, string>;
  redactionPaths: ReturnType<typeof getRedactionPaths>;
  reqController: AbortController;
}

/** Per-call identity + response-cache context threaded into stage-3 response processing. */
interface RestCallCtx {
  client: RegisteredClient;
  tool: RegisteredTool;
  mcpToolName: string;
  callerKey: ReturnType<typeof resolveMcpKeyByToken>;
  guardrails: ReturnType<typeof getGuardrails>;
  responseCacheEnabled: boolean;
  responseCacheKey: string;
  cacheCfg: ReturnType<typeof getToolCacheConfig> | null;
}

/**
 * Stage 1 of dispatchRestToolCall — breaker/LB/canary routing. Runs the circuit-breaker check,
 * N-way load-balancer target selection (which takes precedence over canary), and secondary-upstream
 * (canary/failover) routing, then dispatches the MCP- and WS-kind early paths. Returns a ToolResult
 * for the fail-fast / MCP / WS early-return cases (mirroring the ToolResult|null gate convention),
 * otherwise the routing bundle the caller continues with: the breaker, effective timeout, secondary
 * route + canary config, LB choice/key, and the two breaker/LB outcome recorders (which capture
 * route/lbKey/breaker for the retry loop).
 */
async function resolveRestRouting(
  client: RegisteredClient,
  tool: RegisteredTool,
  mcpToolName: string,
  args: Record<string, unknown>,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
  guardrails: ReturnType<typeof getGuardrails>,
  mockCfg: ReturnType<typeof getToolMock> | null,
  opts: ToolCallOpts | undefined,
): Promise<ToolResult | RestRouting> {
  // Circuit breaker check
  const breaker = getCircuitBreaker(client.name, client.guards?.circuitBreaker);
  const circuitCheck = breaker.canRequest();

  // N-way load balancing (REST only) takes precedence over canary: when a pool
  // is active it owns target selection, so canary routing is skipped. The
  // client-level circuit breaker above stays unchanged — LB spreads load across
  // members and tracks per-target health via its own cooldown, not the breaker.
  const lb = client.kind === "rest" ? getLb(client.name) : null;
  const lbActive = !!lb && lb.enabled && lb.targets.some((t) => t.enabled);
  const lbChoice: LbChoice | null = lbActive ? selectTarget(client, lb!) : null;
  if (lbChoice) lbRequests.inc({ client: client.name, member: lbChoice.isPrimary ? "primary" : "pool" });

  // Secondary-upstream routing (canary / failover) — REST clients only, and only
  // when LB is not active. When the breaker is open and a failover secondary is
  // configured, route there instead of failing fast (bypassing the breaker).
  const canary = client.kind === "rest" && !lbActive ? getCanary(client.name) : null;
  const route = decideSecondary(canary, !circuitCheck.allowed);

  if (!circuitCheck.allowed && !route.useSecondary) {
    if (mockCfg?.enabled && mockCfg.mode === "fallback") return toolResult(mockCfg.response);
    return toolResult(`Circuit breaker OPEN for client '${client.name}' — failing fast`, { isError: true });
  }

  // Use shorter timeout if half-open probe, else the tool's guard override, else the global default.
  const effectiveTimeout = circuitCheck.timeout ?? tool.guards?.timeoutMs ?? config.toolCallTimeoutMs;

  // MCP-kind upstream: forward to the outbound MCP client pool. Every
  // transport-agnostic gate above (enable/deleting/status/key-scope/quota/
  // sensitivity/rate-limit/circuit-breaker) has already applied; only the
  // REST URL/path/IP/fetch machinery below is skipped.
  if (client.kind === "mcp") {
    return dispatchMcpToolCall(
      client,
      tool,
      args,
      mcpToolName,
      effectiveTimeout,
      breaker,
      callerKey,
      guardrails?.scanResponses ?? false,
      opts,
    );
  }

  // WebSocket-backed tool — ephemeral request/response over WS. All the
  // transport-agnostic gates above have already applied; only the HTTP fetch
  // machinery below is replaced by a single WS round-trip.
  const wsCfg = getToolWs(client.name, tool.name);
  if (wsCfg?.enabled) {
    return dispatchWsToolCall(
      client,
      tool,
      args,
      mcpToolName,
      wsCfg,
      effectiveTimeout,
      breaker,
      callerKey,
      guardrails?.scanResponses ?? false,
      opts,
    );
  }

  // When bypassing the primary breaker (failover call to the secondary), the
  // breaker must not record this call's outcome — a secondary success must not
  // prematurely close the breaker and send the next call back to the down
  // primary. Canary calls (breaker was allowed) record normally.
  // When an LB target served the call, mark it healthy/unhealthy for future
  // selection (independent of the client-level breaker).
  const lbKey = lbChoice?.key;
  const recordBreakerSuccess = () => {
    if (!route.bypassBreaker) breaker.recordSuccess();
    if (lbKey) markTargetUp(lbKey);
  };
  const recordBreakerFailure = () => {
    if (!route.bypassBreaker) breaker.recordFailure();
    if (lbKey) markTargetDown(lbKey);
  };
  return { breaker, effectiveTimeout, route, lbChoice, lbKey, recordBreakerSuccess, recordBreakerFailure };
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
async function buildRestRequest(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  lbChoice: LbChoice | null,
  route: ReturnType<typeof decideSecondary>,
  lbKey: string | undefined,
): Promise<ToolResult | RestRequest> {
  // Build URL with path param substitution
  let remainingArgs = { ...args };
  const resolvedPath = tool.endpoint.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, paramName) => {
    const value = remainingArgs[paramName];
    if (value !== undefined) {
      delete remainingArgs[paramName];
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

  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(remainingArgs)) {
      params.append(key, String(value));
    }
    const queryString = params.toString();
    if (queryString) {
      url = `${url}?${queryString}`;
    }
  } else if (graphqlCfg?.enabled) {
    body = JSON.stringify({ query: graphqlCfg.query, variables: remainingArgs });
  } else {
    body = JSON.stringify(remainingArgs);
  }

  // Inject per-client upstream credentials (decrypted at call time). Spread
  // first so the pinned Host and Content-Type set below always take precedence.
  const upstreamAuthHeaders: Record<string, string> = { ...(getUpstreamAuthHeaders(client.name) ?? {}) };
  // Outbound OAuth2 client-credentials — mint/reuse a short-lived token and inject
  // it as a Bearer (the MCP caller never sees the real client secret).
  const oauthBearer = await getOAuthBearer(client.name);
  if (oauthBearer) upstreamAuthHeaders.Authorization = `Bearer ${oauthBearer}`;

  // Response redaction paths for this tool (applied to JSON responses below).
  const redactionPaths = getRedactionPaths(client.name, tool.name);
  return {
    remainingArgs,
    resolvedPath,
    transformCfg,
    targetBaseUrl,
    originalHost,
    pinnedFetch,
    url,
    method,
    body,
    upstreamAuthHeaders,
    redactionPaths,
    reqController,
  };
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
        pin = await refreshPinIfStale(hostname, pin);
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

/**
 * Stage 3 of dispatchRestToolCall — success-response processing. Given a known-good (2xx) Response,
 * reads the body under the streaming size cap (rejecting oversize — proxyBodyCapRejections), records
 * success metrics/usage, then runs the streaming-normalize / paginate → response-transform →
 * redaction → guardrail-scan → context-budget → cache-set pipeline and returns the final ToolResult.
 * No upstream response header is forwarded (Fix 1). The caller records breaker/LB success only
 * AFTER this returns, so a 2xx whose body then resets mid-stream counts as a failure, not a
 * success; the retry/error control flow stays in dispatchRestToolCall.
 */
async function processRestSuccessResponse(
  response: Response,
  attempt: number,
  startTime: number,
  routing: RestRouting,
  req: RestRequest,
  call: RestCallCtx,
): Promise<ToolResult> {
  const { effectiveTimeout, route } = routing;
  const {
    method,
    targetBaseUrl,
    resolvedPath,
    remainingArgs,
    pinnedFetch,
    originalHost,
    upstreamAuthHeaders,
    transformCfg,
    redactionPaths,
    reqController,
  } = req;
  const { client, tool, mcpToolName, callerKey, guardrails, responseCacheEnabled, responseCacheKey, cacheCfg } = call;
  // A2: read body with streaming cap
  const rawText = await readBodyWithCap(response);
  if (rawText === null) {
    proxyBodyCapRejections.inc({ client: client.name });
    log("warn", "Upstream response exceeded size limit", {
      tool: mcpToolName,
      client: client.name,
      limit: config.maxResponseBytes,
    });
    recordToolCall(Date.now() - startTime, true);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: true,
      durationMs: Date.now() - startTime,
    });
    proxyRequestDuration.observe({ client: client.name, method, status_class: "2xx" }, (Date.now() - startTime) / 1000);
    return toolResult("Upstream response exceeded MAX_RESPONSE_BYTES limit", { isError: true });
  }

  const durationSuccess = (Date.now() - startTime) / 1000;
  proxyRequestDuration.observe({ client: client.name, method, status_class: "2xx" }, durationSuccess);
  if (attempt > 0) {
    proxyRetryAttempts.inc({ client: client.name, method, outcome: "success" });
  }
  log("info", "Tool call succeeded", {
    tool: mcpToolName,
    client: client.name,
    status: response.status,
    duration_ms: Date.now() - startTime,
    attempts: attempt + 1,
  });
  recordToolCall(Date.now() - startTime, false);
  recordUsage({
    clientName: client.name,
    toolName: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass: "2xx",
    isError: false,
    durationMs: Date.now() - startTime,
  });

  // Fix 1 — Response header allowlist (no-op confirmation).
  // Only `content-type` is read internally to format the body; no upstream
  // response headers (Set-Cookie, Authorization, WWW-Authenticate, etc.) are
  // forwarded to the MCP caller. The return value carries only the body text,
  // so sensitive headers cannot leak through this code path.
  // Safe-to-forward allowlist (for future reference if headers are ever added):
  //   content-type, content-length, content-encoding, content-language,
  //   cache-control, etag, last-modified, retry-after
  const contentType = response.headers.get("content-type") ?? "";

  // Response pagination — follow cursor/page/link and aggregate the items
  // array across pages BEFORE redaction/guardrail/cache. JSON GET only; the
  // follow-ups reuse the pinned IP + Host of this request.
  let bodyText = rawText;
  const streamingCfg = getStreamingConfig(client.name, tool.name);
  if (streamingCfg?.enabled) {
    // Normalize a streaming-format body (NDJSON / SSE) into one aggregated
    // JSON result — MCP returns a single tool result, so the upstream stream
    // must complete (bounded by the response byte cap).
    bodyText = JSON.stringify({ events: parseStream(rawText, streamingCfg.format, streamingCfg.maxEvents) }, null, 2);
  } else if (method === "GET" && contentType.includes("application/json")) {
    const paginationCfg = getPaginationConfig(client.name, tool.name);
    if (paginationCfg?.enabled) {
      const aggregated = await fetchAllPages(rawText, paginationCfg, {
        targetBaseUrl,
        resolvedPath,
        baseQuery: new URLSearchParams(
          Object.entries(remainingArgs).map(([k, v]) => [k, String(v)] as [string, string]),
        ),
        pinnedFetch,
        originalHost,
        headers: upstreamAuthHeaders,
        timeoutMs: effectiveTimeout,
        externalSignal: reqController.signal,
        maxBytes: config.maxResponseBytes,
        firstBytes: new TextEncoder().encode(rawText).length,
        firstLink: response.headers.get("link"),
      });
      if (aggregated !== null) bodyText = aggregated;
    }
  }

  // Declarative response transform on the parsed JSON body (pre-redaction).
  if (transformCfg?.enabled && transformCfg.response.length > 0) {
    try {
      bodyText = JSON.stringify(applyOps(JSON.parse(bodyText), transformCfg.response), null, 2);
    } catch {
      /* non-JSON body: leave unchanged */
    }
  }

  let responseText = bodyText;
  if (contentType.includes("application/json")) {
    // applyRedaction parses, redacts configured paths, and pretty-prints;
    // returns null on non-JSON so we fall back to the raw text.
    const processed = applyRedaction(redactionPaths, bodyText);
    if (processed !== null) responseText = processed;
  }

  // Response guardrail scan (spotlighting) — runs after redaction so the
  // envelope wraps the already-redacted text, not raw secrets.
  if (guardrails?.scanResponses) {
    const scan = applyResponseScan(responseText);
    recordGuardrailHit(client.name, tool.name, scan.flagged);
    if (scan.flagged) {
      log("warn", "Tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
      responseText = scan.text;
    }
  }

  // Context budget — MUST run after redaction and the guardrail scan above:
  // this is the last transformation before the response is cached/returned,
  // so an opt-in llm_summarize call only ever sees already-sanitized text.
  const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, responseText);
  responseText = budgeted.text;

  // Strip the gateway's own injected upstream credential if the backend
  // reflected it into the body — before caching, so cache hits are safe too.
  responseText = stripInjectedCredentials(responseText, upstreamAuthHeaders);

  if (responseCacheEnabled && cacheCfg && !route.useSecondary) {
    cacheSet(responseCacheKey, { content: [{ type: "text", text: responseText }] }, cacheCfg.ttlSeconds);
    cacheEvents.inc({ client: client.name, outcome: "store" });
  }
  return toolResult(responseText);
}

/**
 * The REST/GraphQL/WS/MCP dispatch path, hoisted out of dispatchToolCall. Every
 * transport-agnostic gate (enable/scope/quota/sensitivity/quarantine/approval/
 * guardrails/rate-limit/mock/cache) has already run; this owns breaker/LB/canary
 * routing, request building + IP pinning, the retry loop, and response processing.
 */
export async function dispatchRestToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  mcpToolName: string,
  args: Record<string, unknown>,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
  guardrails: ReturnType<typeof getGuardrails>,
  mockCfg: ReturnType<typeof getToolMock> | null,
  responseCacheEnabled: boolean,
  responseCacheKey: string,
  cacheCfg: ReturnType<typeof getToolCacheConfig> | null,
  opts: ToolCallOpts | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const call: RestCallCtx = {
    client,
    tool,
    mcpToolName,
    callerKey,
    guardrails,
    responseCacheEnabled,
    responseCacheKey,
    cacheCfg,
  };

  const routing = await resolveRestRouting(client, tool, mcpToolName, args, callerKey, guardrails, mockCfg, opts);
  if ("content" in routing) return routing;
  const { breaker, effectiveTimeout, route, lbChoice, lbKey, recordBreakerSuccess, recordBreakerFailure } = routing;

  const built = await buildRestRequest(client, tool, args, lbChoice, route, lbKey);
  if ("content" in built) {
    // buildRestRequest bailed before reaching the backend (arg validation, path
    // traversal, a failed pin refresh, or mid-unregister) — no signal about
    // backend health, so release any half-open probe consumed by canRequest() in
    // resolveRestRouting rather than stranding it (which would wedge the breaker
    // in half_open forever). No-op when no probe is in flight.
    breaker.releaseProbe();
    return built;
  }
  const { method, url, body, upstreamAuthHeaders, reqController, pinnedFetch } = built;

  const startTime = Date.now();

  // GET / HEAD / OPTIONS are always retried.
  // DELETE / PUT are only retried when the client opts in via retry_non_safe_methods.
  const alwaysSafe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const optedIn = client.retry_non_safe_methods === true && (method === "DELETE" || method === "PUT");
  const isIdempotent = alwaysSafe || optedIn;

  const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);
  const MAX_RETRIES = config.retryMaxAttempts;
  const BASE_DELAY = config.retryBaseDelayMs;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  // Terminal-failure recording, shared by all three REST failure exits
  // (non-retryable error response, network throw, retries exhausted). Each used
  // to hand-roll the same quintet — duration metric, breaker failure, log,
  // recordToolCall, recordUsage — followed by the mock-fallback-or-error result;
  // keeping three copies in lockstep was a standing drift hazard. `durationMs` is
  // passed in rather than measured here so the non-retryable branch can record
  // BEFORE it reads the (capped, potentially large) error body.
  const recordFailure = (f: {
    durationMs: number;
    statusClass: string;
    logLevel: "warn" | "error";
    logMessage: string;
    logExtra: Record<string, unknown>;
    mockResult: string | null;
    resultMessage: string;
  }) => {
    proxyRequestDuration.observe({ client: client.name, method, status_class: f.statusClass }, f.durationMs / 1000);
    recordBreakerFailure();
    log(f.logLevel, f.logMessage, {
      tool: mcpToolName,
      client: client.name,
      duration_ms: f.durationMs,
      ...f.logExtra,
    });
    recordToolCall(f.durationMs, true);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: f.statusClass,
      isError: true,
      durationMs: f.durationMs,
    });
    if (f.mockResult !== null) return toolResult(f.mockResult);
    return toolResult(f.resultMessage, { isError: true });
  };

  try {
    for (let attempt = 0; attempt <= (isIdempotent ? MAX_RETRIES : 0); attempt++) {
      if (attempt > 0) {
        // Don't retry if the circuit is now open — but ONLY for a normal
        // (primary) call. When this call is deliberately routed to the failover
        // secondary (route.bypassBreaker), the primary breaker is open by
        // definition, so re-checking it here would (a) cancel every retry to a
        // healthy secondary exactly when the primary is down, and (b) risk
        // consuming the primary's half-open probe slot if its reset timeout
        // fired during the backoff — a probe the secondary call then never
        // clears (recordBreaker* skip the breaker when bypassing).
        if (!route.bypassBreaker && !breaker.canRequest().allowed) break;
        const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // A1: build a fresh composed signal per attempt so the timeout is renewed each time.
      // reqController.signal stays persistent (external client cancellation).
      const attemptSignal = AbortSignal.any([reqController.signal, AbortSignal.timeout(effectiveTimeout)]);

      // Host header + redirect:"error" + hostname->IP pinning are all applied by
      // pinnedFetch (makePinnedFetch); the options below carry only method, the
      // trace/auth/content-type headers, the body, and the per-attempt signal.
      const fetchOptions: RequestInit =
        body !== undefined
          ? {
              method,
              headers: outboundTraceHeaders(undefined, {
                ...upstreamAuthHeaders,
                "Content-Type": "application/json",
              }),
              body,
              signal: attemptSignal,
            }
          : {
              method,
              headers: outboundTraceHeaders(undefined, {
                ...upstreamAuthHeaders,
                "Content-Type": "application/json",
              }),
              signal: attemptSignal,
            };

      try {
        const response = await pinnedFetch(url, fetchOptions);

        if (response.ok) {
          // Record breaker/LB success only AFTER the body is fully read: if the
          // connection resets mid-stream, processRestSuccessResponse throws and
          // control falls to the catch below (a failure) — so one call can never
          // log both a success and a failure, which would otherwise keep a
          // half-broken backend's breaker from ever opening.
          const success = await processRestSuccessResponse(response, attempt, startTime, routing, built, call);
          recordBreakerSuccess();
          return success;
        }

        lastStatus = response.status;

        // Check if retryable
        if (isIdempotent && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
          // A3: handle Retry-After header (integer seconds OR HTTP-date)
          if (response.status === 429) {
            const waitMs = parseRetryAfter(response.headers.get("retry-after"));
            if (waitMs !== null && waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }
          continue;
        }

        // Non-retryable error response — measure first, then read the (capped)
        // error body for the result message, then record the failure.
        const errDurationMs = Date.now() - startTime;
        // Fix 3 — cap error-response body via the same readBodyWithCap helper used for
        // success responses, preventing a malicious upstream from OOM-ing the bridge with
        // an oversized error body (e.g. a 400 with a 10 GB payload).
        const errorBody = await readBodyWithCap(response);
        let errorBodyText =
          errorBody === null ? `[body truncated — exceeded ${config.maxResponseBytes} byte limit]` : errorBody;
        // Response-sanitization parity with the success path: a 4xx/5xx body can
        // carry the same secrets (e.g. a debug 400 echoing the gateway-injected
        // Authorization) or a prompt-injection payload as a 2xx body, so run the
        // configured redaction paths + guardrail scan over it before it reaches
        // the caller. (Skip the truncation-placeholder case — nothing to redact.)
        if (errorBody !== null) {
          const redacted = applyRedaction(built.redactionPaths, errorBodyText);
          if (redacted !== null) errorBodyText = redacted;
          if (guardrails?.scanResponses) {
            const scan = applyResponseScan(errorBodyText);
            recordGuardrailHit(client.name, tool.name, scan.flagged);
            if (scan.flagged) {
              log("warn", "Tool error response flagged by guardrail scan", {
                tool: mcpToolName,
                client: client.name,
              });
              errorBodyText = scan.text;
            }
          }
          // Strip the gateway's own injected upstream credential if the error
          // body reflected it (e.g. a debug 400 echoing the Authorization).
          errorBodyText = stripInjectedCredentials(errorBodyText, upstreamAuthHeaders);
        }
        return recordFailure({
          durationMs: errDurationMs,
          statusClass: httpStatusClass(response.status),
          logLevel: "warn",
          logMessage: "Tool call returned error",
          logExtra: { status: response.status, attempts: attempt + 1 },
          mockResult:
            mockCfg?.enabled && mockCfg.mode === "fallback" && response.status >= 500 ? mockCfg.response : null,
          resultMessage: `REST API returned ${response.status}: ${errorBodyText}`,
        });
      } catch (error) {
        lastError = errorMessage(error);
        if (!isIdempotent || attempt >= MAX_RETRIES) {
          return recordFailure({
            durationMs: Date.now() - startTime,
            statusClass: "error",
            logLevel: "error",
            logMessage: "Tool call failed",
            logExtra: { error: lastError, attempts: attempt + 1 },
            mockResult: mockCfg?.enabled && mockCfg.mode === "fallback" ? mockCfg.response : null,
            resultMessage: `Failed to reach ${client.name}: ${lastError}`,
          });
        }
        proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
      }
    }

    // Exhausted retries
    proxyRetryAttempts.inc({ client: client.name, method, outcome: "exhausted" });
    const errorMsg = lastError || `REST API returned ${lastStatus}`;
    return recordFailure({
      durationMs: Date.now() - startTime,
      statusClass: lastError ? "error" : httpStatusClass(lastStatus ?? 0),
      logLevel: "error",
      logMessage: "Tool call failed after retries",
      logExtra: { error: errorMsg, attempts: MAX_RETRIES + 1 },
      mockResult: mockCfg?.enabled && mockCfg.mode === "fallback" ? mockCfg.response : null,
      resultMessage: `Failed after ${MAX_RETRIES + 1} attempts to reach ${client.name}: ${errorMsg}`,
    });
  } finally {
    untrackRequest(client.name, reqController);
    if (lbKey) decInflight(lbKey);
  }
}
