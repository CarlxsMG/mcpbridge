import { registry } from "../mcp/registry.js";
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
  coalesceHits,
} from "../observability/metrics.js";
import { getToolCacheConfig, cacheKey, cacheSet } from "../tool-policies/response-cache.js";
import { getToolCoalesce, runCoalesced } from "../tool-policies/coalesce.js";
import {
  getLb,
  selectTarget,
  markTargetUp,
  markTargetDown,
  incInflight,
  decInflight,
  type LbChoice,
} from "../tool-policies/load-balancer.js";
import {
  getPaginationConfig,
  extractItems,
  nextCursorValue,
  parseNextLink,
  withItems,
  type PaginationConfig,
} from "../tool-policies/pagination.js";
import { getStreamingConfig, parseStream } from "./streaming.js";
import { getToolTransform, applyOps } from "./transform.js";
import { getToolMock } from "../tool-meta/tool-mock.js";
import { recordTraffic } from "../observability/traffic.js";
import { outboundTraceHeaders } from "../observability/trace-context.js";
import { getToolGraphql, getToolWs } from "./backends.js";
import { getOAuthBearer } from "../backend-auth/oauth.js";
import { isDeleting } from "../mcp/registry.js";
import { resolveMcpKeyByToken } from "../security/mcp-key-store.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { recordUsage } from "../observability/usage.js";
import { getRedactionPaths, applyRedaction } from "../content-filtering/redaction.js";
import { getGuardrails, applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import { getCanary, decideSecondary } from "../tool-policies/canary.js";
import { tracingEnabled, startSpan, endSpan } from "../observability/tracing.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { toolResult } from "../lib/mcp-result.js";
import {
  checkConsumerQuotaGate,
  checkSensitiveToolGate,
  checkClientToolAvailable,
  checkAllowedKeyGate,
  checkToolRateLimitGate,
  checkKeyScopeGate,
  checkQuarantineAndApprovalGate,
  checkGuardrailInputGate,
  checkMockAlwaysShortCircuit,
  checkResponseCacheShortCircuit,
  type ToolResult,
} from "./gates.js";
import { getOrCompile } from "./schema-validator.js";
import { dispatchWsToolCall } from "./dispatch-ws.js";
import { dispatchMcpToolCall } from "./dispatch-mcp.js";
import { errorMessage } from "../lib/error-message.js";

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
 * Parse a Retry-After header value into a wait duration in milliseconds.
 * Handles both integer-seconds ("120") and HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT") forms.
 * Returns null when the value cannot be parsed or exceeds `config.retryAfterMaxMs`.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  // 1) Integer seconds form
  const seconds = parseInt(headerValue, 10);
  if (Number.isFinite(seconds)) {
    const ms = seconds * 1000;
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  // 2) HTTP-date form
  const dateMs = Date.parse(headerValue);
  if (!isNaN(dateMs)) {
    const ms = dateMs - Date.now();
    if (ms >= 0 && ms <= config.retryAfterMaxMs) return ms;
    return null;
  }

  return null;
}

function httpStatusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/**
 * Read the response body as a stream, enforcing `config.maxResponseBytes`.
 * Returns the raw text on success, or null when the limit is exceeded (after cancelling the reader).
 */
async function readBodyWithCap(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments where body is not a ReadableStream
    return response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > config.maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

interface PageCtx {
  targetBaseUrl: string;
  resolvedPath: string;
  baseQuery: URLSearchParams;
  /**
   * The shared DNS-pinned fetch from the primary request (makePinnedFetch):
   * swaps the original hostname for the SSRF-validated IP, preserves the Host
   * header, and refuses redirects. Every follow-up page reuses it, so pagination
   * pins exactly like the primary request without re-implementing the technique.
   */
  pinnedFetch: PinnedFetch;
  /** Original host:port of the primary request — used only for the cross-host next-link guard. */
  originalHost: string;
  headers: Record<string, string>;
  timeoutMs: number;
  externalSignal: AbortSignal;
  maxBytes: number;
  firstBytes: number;
  firstLink: string | null;
}

/**
 * Builds a same-host page URL keeping the original hostname — the pinned fetch
 * (ctx.pinnedFetch) swaps it to the validated IP at request time.
 */
function buildPageUrl(baseUrl: string, path: string, query: URLSearchParams): string {
  const u = new URL(`${baseUrl}${path}`);
  u.search = query.toString();
  return u.toString();
}

/**
 * Follows pagination from a first JSON page, aggregating the array at
 * `cfg.itemsPath` across pages. Returns the merged body as pretty JSON, or null
 * when the first body isn't paginable (not JSON / itemsPath not an array / empty).
 * Every follow-up reuses the pinned IP + Host of the primary request; a `link`
 * next URL to a different host is not followed (SSRF-safe). Bounded by
 * cfg.maxPages and the aggregate byte cap.
 */
async function fetchAllPages(firstBodyText: string, cfg: PaginationConfig, ctx: PageCtx): Promise<string | null> {
  let firstBody: unknown;
  try {
    firstBody = JSON.parse(firstBodyText);
  } catch {
    return null;
  }
  const firstItems = extractItems(firstBody, cfg.itemsPath);
  if (!firstItems || firstItems.length === 0) return null;

  const all: unknown[] = [...firstItems];
  let totalBytes = ctx.firstBytes;
  let cursor: string | null =
    cfg.strategy === "cursor" ? nextCursorValue(firstBody, cfg.cursorResponsePath ?? "") : null;
  let link: string | null = cfg.strategy === "link" ? parseNextLink(ctx.firstLink) : null;
  let pageNum = 2;

  const fetchPage = async (urlStr: string): Promise<{ ok: boolean; text: string | null; link: string | null }> => {
    const signal = AbortSignal.any([ctx.externalSignal, AbortSignal.timeout(ctx.timeoutMs)]);
    // urlStr carries the ORIGINAL hostname; ctx.pinnedFetch swaps it to the
    // validated IP, sets the Host header (host:port) from the URL, and refuses
    // redirects — the identical DNS-rebinding-safe transport the primary used.
    const resp = await ctx.pinnedFetch(urlStr, {
      method: "GET",
      headers: { ...ctx.headers, "Content-Type": "application/json" },
      signal,
    });
    const text = resp.ok ? await readBodyWithCap(resp) : null;
    return { ok: resp.ok, text, link: resp.headers.get("link") };
  };

  const limit = Math.min(cfg.maxPages, 100);
  for (let page = 1; page < limit; page++) {
    let urlStr: string;
    if (cfg.strategy === "cursor") {
      if (!cursor) break;
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.cursorParam ?? "cursor", cursor);
      urlStr = buildPageUrl(ctx.targetBaseUrl, ctx.resolvedPath, q);
    } else if (cfg.strategy === "page") {
      const q = new URLSearchParams(ctx.baseQuery);
      q.set(cfg.pageParam ?? "page", String(pageNum));
      urlStr = buildPageUrl(ctx.targetBaseUrl, ctx.resolvedPath, q);
    } else {
      if (!link) break;
      let linkUrl: URL;
      try {
        linkUrl = new URL(link);
      } catch {
        break;
      }
      if (linkUrl.host !== ctx.originalHost) break; // cross-host next: stop (SSRF-safe)
      urlStr = linkUrl.toString(); // original hostname; ctx.pinnedFetch pins it to the validated IP
    }

    let res: { ok: boolean; text: string | null; link: string | null };
    try {
      res = await fetchPage(urlStr);
    } catch {
      break;
    }
    if (!res.ok || res.text === null) break;

    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      break;
    }
    const items = extractItems(body, cfg.itemsPath);
    if (!items || items.length === 0) break;

    all.push(...items);
    totalBytes += new TextEncoder().encode(res.text).length;
    if (totalBytes > ctx.maxBytes) break;

    if (cfg.strategy === "cursor") {
      cursor = nextCursorValue(body, cfg.cursorResponsePath ?? "");
      if (!cursor) break;
    } else if (cfg.strategy === "link") {
      link = parseNextLink(res.link);
      if (!link) break;
    } else {
      pageNum++;
    }
  }

  return JSON.stringify(withItems(firstBody, cfg.itemsPath, all), null, 2);
}

/**
 * Optional per-call bridging for MCP-to-MCP progress/cancellation forwarding
 * (kind:"mcp" upstreams only — see dispatchMcpToolCall). `signal` is the
 * downstream caller's own cancellation (auto-aborted by the SDK on
 * notifications/cancelled); `onProgress` is only ever set when the downstream
 * caller itself requested progress (a `_meta.progressToken` on its call), so
 * an upstream that doesn't support progress is simply never asked for it.
 */
export interface ToolCallOpts {
  signal?: AbortSignal;
  onProgress?: (progress: number, total?: number, message?: string) => void;
  /** Caller-asserted end-user identity (X-End-User-Id header), for optional
   * per-end-user rate limiting. Unauthenticated — see resolveEndUserId. */
  endUserId?: string;
  /** The calling MCP transport session id (extra.sessionId from the SDK's
   * RequestHandlerExtra — see transports.ts's session maps), threaded through
   * so the trace viewer can attribute a span to the session/agent run that
   * caused it, not just the API key. Undefined for callers with no live MCP
   * session (composite steps, admin test-calls). */
  sessionId?: string;
}

/**
 * Public entry point. When OTLP tracing is enabled, wraps the dispatch in a
 * CLIENT span (bridge -> backend) with the tool name and error outcome; a no-op
 * passthrough otherwise. Kept as a thin wrapper so every caller
 * (mcp-server/composites/admin test route) is traced without change.
 */
export async function proxyToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {},
  callerToken?: string,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const capture = config.trafficCaptureEnabled;
  const started = capture ? Date.now() : 0;

  let result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  if (!tracingEnabled()) {
    result = await dispatchToolCall(mcpToolName, args, callerToken, opts);
  } else {
    const span = startSpan(`tool_call ${mcpToolName}`, { "mcp.tool": mcpToolName });
    result = await dispatchToolCall(mcpToolName, args, callerToken, opts);
    endSpan(
      span,
      {
        "mcp.tool.is_error": result.isError === true,
        ...(opts?.sessionId ? { "mcp.session_id": opts.sessionId } : {}),
      },
      result.isError ? 2 : 1,
    );
  }

  // Traffic capture — a single point covering every dispatch outcome. Opt-in.
  if (capture) {
    const resolved = registry.resolveTool(mcpToolName);
    recordTraffic({
      mcpToolName,
      clientName: resolved?.client.name ?? null,
      toolName: resolved?.tool.name ?? null,
      keyId: callerToken ? (resolveMcpKeyByToken(callerToken)?.id ?? null) : null,
      args,
      result,
      durationMs: Date.now() - started,
    });
  }
  return result;
}

async function dispatchToolCall(
  mcpToolName: string,
  args: Record<string, unknown> = {},
  callerToken?: string,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = registry.resolveTool(mcpToolName);

  if (resolved === undefined) {
    return toolResult(`Unknown tool: ${mcpToolName}`, { isError: true });
  }

  const { client, tool } = resolved;

  // Availability backstop (disabled / deleting / unreachable).
  {
    const gate = checkClientToolAvailable(client, tool, mcpToolName);
    if (gate) return gate;
  }

  // Allowed-key restriction — runs before the circuit breaker (a guard-rejected
  // call must not burn a half-open probe).
  {
    const gate = checkAllowedKeyGate(tool, callerToken, mcpToolName);
    if (gate) return gate;
  }

  // Resolve the managed key once — used for scope enforcement here and for
  // usage attribution at every terminal outcome below. Legacy env keys and
  // admin test-calls resolve to null (no scope restriction, unattributed).
  const callerKey = callerToken ? resolveMcpKeyByToken(callerToken) : null;
  {
    const gate = checkKeyScopeGate(callerKey, client, mcpToolName);
    if (gate) return gate;
  }

  // Multi-tenant monthly quota + per-end-user rate limit.
  {
    const gate = checkConsumerQuotaGate(callerKey, args, opts);
    if (gate) return gate;
  }

  // Destructive-action gating (__confirm is stripped later by Ajv's removeAdditional).
  {
    const gate = checkSensitiveToolGate(client, tool, args, callerKey, mcpToolName);
    if (gate) return gate;
  }

  // Auto-quarantine + human-in-the-loop approval gate (both run before the breaker).
  {
    const gate = checkQuarantineAndApprovalGate(client, tool, args, mcpToolName, callerKey);
    if (gate) return gate;
  }

  // Content guardrails — input gate (before the breaker, so a reject never burns a
  // half-open probe). `guardrails` is kept for the response scan on the output path.
  const guardrails = getGuardrails(client.name, tool.name);
  {
    const gate = checkGuardrailInputGate(guardrails, client, tool, args, mcpToolName);
    if (gate) return gate;
  }

  {
    const gate = checkToolRateLimitGate(tool, mcpToolName);
    if (gate) return gate;
  }

  // Mock / virtualization. An "always" mock short-circuits the upstream (after
  // guards, before the breaker — like the cache). A "fallback" mock is returned
  // only when the backend is unavailable (checked at the failure returns below).
  const mockCfg = client.kind === "rest" ? getToolMock(client.name, tool.name) : null;
  {
    const sc = checkMockAlwaysShortCircuit(mockCfg, client, tool, mcpToolName, callerKey);
    if (sc) return sc;
  }

  // ── Response cache (lookup) ────────────────────────────────────────────────
  // Idempotent GET responses may be served from an in-memory TTL cache, skipping
  // the upstream entirely. Runs AFTER every auth/guard/rate-limit gate (a hit
  // still counts against them) but BEFORE the circuit breaker, so a hit never
  // consumes a half-open probe slot (rule 4, above). REST GET only; the cached
  // value is the already-redacted/guardrail-scanned text, so every authorised
  // caller gets identical output and no raw secret is ever stored.
  const cacheCfg =
    client.kind === "rest" && tool.method.toUpperCase() === "GET" ? getToolCacheConfig(client.name, tool.name) : null;
  const responseCacheEnabled = cacheCfg?.enabled === true;
  const responseCacheKey = responseCacheEnabled ? cacheKey(client.name, tool.name, client.base_url, args) : "";
  {
    const sc = checkResponseCacheShortCircuit(
      responseCacheEnabled,
      responseCacheKey,
      client,
      tool,
      mcpToolName,
      callerKey,
    );
    if (sc) return sc;
  }

  // Request coalescing — concurrent identical in-flight REST GET calls share a
  // single upstream fetch. Every gate above (scope/quota/sensitivity/approval/
  // guardrails) already ran for THIS caller, so piggybacking on another
  // caller's in-flight request never bypasses per-caller authorization; only
  // the network fetch and its breaker/LB bookkeeping are shared (rule 4 also
  // means this decision must wrap the breaker check below, not just the
  // fetch — calling canRequest() once per piggybacker would spuriously burn
  // extra half-open probe slots).
  const coalesceCfg =
    client.kind === "rest" && tool.method.toUpperCase() === "GET" ? getToolCoalesce(client.name, tool.name) : null;
  const coalesceKey = coalesceCfg?.enabled
    ? responseCacheKey || cacheKey(client.name, tool.name, client.base_url, args)
    : "";

  const runRest = () =>
    dispatchRestToolCall(
      client,
      tool,
      mcpToolName,
      args,
      callerKey,
      guardrails,
      mockCfg,
      responseCacheEnabled,
      responseCacheKey,
      cacheCfg,
      opts,
    );

  if (coalesceCfg?.enabled) {
    const { result, piggybacked } = await runCoalesced(coalesceKey, runRest);
    if (piggybacked) coalesceHits.inc({ client: client.name });
    return result;
  }
  return runRest();
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
    return dispatchWsToolCall(client, tool, args, wsCfg, effectiveTimeout, breaker, callerKey, opts);
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
 * No upstream response header is forwarded (Fix 1). Called by the retry loop right after
 * recordBreakerSuccess(); the retry/error control flow stays in dispatchRestToolCall.
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
async function dispatchRestToolCall(
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
  if ("content" in built) return built;
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
        // Don't retry if circuit is now open
        if (!breaker.canRequest().allowed) break;
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
          recordBreakerSuccess();
          return await processRestSuccessResponse(response, attempt, startTime, routing, built, call);
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
        const errorBodyText =
          errorBody === null ? `[body truncated — exceeded ${config.maxResponseBytes} byte limit]` : errorBody;
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
