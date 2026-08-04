import { config } from "../config.js";
import { log } from "../logger.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { proxyRetryAttempts, lbRequests } from "../observability/metrics.js";
import { getToolCacheConfig } from "../tool-policies/response-cache.js";
import {
  getLb,
  selectTarget,
  markTargetUp,
  markTargetDown,
  decInflight,
  type LbChoice,
} from "../tool-policies/load-balancer.js";
import { parseRetryAfter, httpStatusClass, readBodyWithCap } from "./http-util.js";
import { getToolMock } from "../tool-meta/tool-mock.js";
import { outboundTraceHeaders } from "../observability/trace-context.js";
import { getToolWs } from "./backends.js";
import { resolveMcpKeyByToken } from "../security/mcp-key-store.js";
import { recordCallOutcome } from "../observability/call-outcome.js";
import { getGuardrails } from "../tool-policies/guardrails.js";
import { getCanary, decideSecondary } from "../tool-policies/canary.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolResult } from "./gates.js";
import { dispatchWsToolCall } from "./dispatch-ws.js";
import { dispatchMcpToolCall } from "./dispatch-mcp.js";
import { errorMessage } from "../lib/error-message.js";
import type { ToolCallOpts } from "./proxy.js";
import { buildRestRequest, untrackRequest } from "./rest-request.js";
import { processRestSuccessResponse, sanitizeRestResponse, type RestCallCtx } from "./rest-response.js";
// Re-exported so proxy.ts (and anything else) keeps importing these from the
// dispatch module rather than having to know which stage file now owns them.
export { abortClientRequests, invalidatePinnedIp } from "./rest-request.js";

// ===========================================================================
// REST dispatch machine — the third of the three transport dispatchers
// (siblings dispatch-mcp.ts / dispatch-ws.ts handle the other two). proxy.ts's
// dispatchToolCall runs the transport-agnostic gate pipeline and then hands off
// to dispatchRestToolCall below.
//
// The machine has three stages, and each now has a file:
//
//   1. THIS FILE — breaker / LB / canary routing (including the early MCP- and
//      WS-kind hand-offs), the retry loop, and the orchestration that threads
//      the other two together.
//   2. ./rest-request.ts — request building and SSRF IP pinning, plus the
//      pinned-IP cache and the per-client in-flight/abort registry it owns.
//   3. ./rest-response.ts — response sanitizing, GraphQL 200-with-errors
//      detection, caching and outcome recording.
//
// They were one ~1120-line file. Splitting on the stage boundaries the code
// already had (the three docblocks said "Stage 1/2/3") put each piece of
// module-level state next to its only writer; nothing moved between stages.
//
// `ToolCallOpts` still lives in proxy.ts (the shared public entry-point type);
// importing it back here is the same intentional cycle dispatch-mcp/ws use, and
// ./rest-response.ts imports `RestRouting` back from here on the same basis.
// ===========================================================================

/**
 * Stage-1 routing decision returned by resolveRestRouting (breaker/LB/canary +
 * outcome recorders). Exported for ./rest-response.ts, which reads the
 * effective timeout and secondary route when recording a call's outcome — a
 * type-only cycle, the same shape as ToolCallOpts coming back from proxy.ts.
 */
export interface RestRouting {
  breaker: ReturnType<typeof getCircuitBreaker>;
  effectiveTimeout: number;
  route: ReturnType<typeof decideSecondary>;
  lbChoice: LbChoice | null;
  lbKey: string | undefined;
  /** True iff canRequest() admitted THIS call as the breaker's one half-open probe (see probeGranted below). */
  probeGranted: boolean;
  recordBreakerSuccess: () => void;
  recordBreakerFailure: () => void;
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

  // Whether THIS call was the one canRequest() admitted as the half-open probe:
  // that grant is the only branch that returns a `timeout` (the half-open probe
  // timeout) alongside allowed, so its presence uniquely identifies the probe
  // holder. A concurrent call rejected as "Probing" (allowed=false) never held
  // the probe, so it must never release the real probe holder's slot (Fix 5).
  const probeGranted = circuitCheck.allowed && circuitCheck.timeout !== undefined;

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

  // Any call routed to the SECONDARY (canary OR failover) carries no health
  // signal about the PRIMARY, so it must neither record an outcome against the
  // primary breaker nor resolve its half-open probe. Recording a secondary's
  // success/failure against the primary breaker would flap it (a healthy
  // secondary prematurely closing an open primary's breaker, or a failing
  // secondary opening a healthy primary's). Guarding on route.useSecondary (a
  // superset of route.bypassBreaker, which is set only for failover+open)
  // covers the canary case the old bypassBreaker guard missed. When this same
  // call was itself admitted as the half-open probe (probeGranted — a canary
  // call routed to the secondary can hold one), release it so it isn't stranded
  // in-flight; but ONLY when this call held it, never on behalf of a concurrent
  // probe holder. When an LB target served the call, mark it healthy/unhealthy
  // for future selection (independent of the client-level breaker).
  const lbKey = lbChoice?.key;
  const recordBreakerSuccess = () => {
    if (route.useSecondary) {
      if (probeGranted) breaker.releaseProbe();
    } else {
      breaker.recordSuccess();
    }
    if (lbKey) markTargetUp(lbKey);
  };
  const recordBreakerFailure = () => {
    if (route.useSecondary) {
      if (probeGranted) breaker.releaseProbe();
    } else {
      breaker.recordFailure();
    }
    if (lbKey) markTargetDown(lbKey);
  };
  return {
    breaker,
    effectiveTimeout,
    route,
    lbChoice,
    lbKey,
    probeGranted,
    recordBreakerSuccess,
    recordBreakerFailure,
  };
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
): Promise<ToolResult> {
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
  const {
    breaker,
    effectiveTimeout,
    route,
    lbChoice,
    lbKey,
    probeGranted,
    recordBreakerSuccess,
    recordBreakerFailure,
  } = routing;

  // Single obligation to release a consumed half-open probe, covering every exit
  // from the dispatch body below. canRequest() (in resolveRestRouting) may have
  // admitted THIS call as the breaker's one half-open probe; if it did
  // (probeGranted), every path out — buildRestRequest bailing (arg validation /
  // path traversal / failed pin refresh / mid-unregister), a throw during request
  // building before the backend dial, caller cancellation, or a normal
  // success/failure — must release that probe rather than strand it in-flight
  // (which would wedge the breaker in half_open: every later call is rejected as
  // "Probing" and the idle sweep never evicts it because each rejected
  // canRequest() refreshes lastAccess). Consolidating it into one finally
  // replaces the previously-scattered manual releaseProbe() calls. releaseProbe()
  // is a no-op after record* (the breaker has already left half_open) and when no
  // probe is in flight, so it stays correct even after a recorded success/failure.
  // It is guarded by probeGranted so a concurrent call that never held the probe
  // (e.g. one rejected as "Probing" then routed to a canary/failover secondary)
  // can never release the real probe holder's slot — the same Fix 5 invariant
  // recordBreakerSuccess/Failure keep.
  try {
    const built = await buildRestRequest(client, tool, args, lbChoice, route, lbKey);
    // buildRestRequest bailed before reaching the backend (arg validation, path
    // traversal, a failed pin refresh, or mid-unregister) — no signal about
    // backend health; the finally below releases any consumed half-open probe.
    if ("content" in built) return built;
    const { method, url, body, upstreamAuthHeaders, paramHeaders, reqController, pinnedFetch } = built;

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
      recordBreakerFailure();
      log(f.logLevel, f.logMessage, {
        tool: mcpToolName,
        client: client.name,
        duration_ms: f.durationMs,
        ...f.logExtra,
      });
      recordCallOutcome({
        client: client.name,
        tool: tool.name,
        keyId: callerKey?.id ?? null,
        statusClass: f.statusClass,
        isError: true,
        durationMs: f.durationMs,
        method,
      });
      if (f.mockResult !== null) return toolResult(f.mockResult);
      return toolResult(f.resultMessage, { isError: true });
    };

    // Set when the previous attempt already slept for a 429 Retry-After, so this
    // attempt skips the exponential backoff instead of summing the two waits.
    let retryAfterHonored = false;
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
          if (retryAfterHonored) {
            // The backend already told us exactly how long to wait via Retry-After
            // and we slept it; adding the exponential backoff on top would double
            // the delay. Honor the server's hint alone for this transition.
            retryAfterHonored = false;
          } else {
            const delay = BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        // A1: build a fresh composed signal per attempt so the timeout is renewed each time.
        // reqController.signal stays persistent (client-teardown cancellation);
        // opts.signal is the downstream MCP caller's own cancellation (auto-aborted
        // by the SDK on notifications/cancelled) — include it so an in-flight REST
        // call actually aborts, matching the MCP/WS paths (Fix 6). Filter undefined
        // so a caller with no signal composes only the two internal ones.
        const attemptSignal = AbortSignal.any(
          [reqController.signal, AbortSignal.timeout(effectiveTimeout), opts?.signal].filter(
            (s): s is AbortSignal => s !== undefined,
          ),
        );

        // Host header + redirect:"error" + hostname->IP pinning are all applied by
        // pinnedFetch (makePinnedFetch); the options below carry only method, the
        // trace/auth/content-type headers, the body, and the per-attempt signal.
        // paramHeaders (OpenAPI in:header/cookie params) go first so injected
        // upstream auth, the pinned Host, and Content-Type always win over any
        // caller-supplied param that happens to share a header name.
        const fetchOptions: RequestInit =
          body !== undefined
            ? {
                method,
                headers: outboundTraceHeaders(undefined, {
                  ...paramHeaders,
                  ...upstreamAuthHeaders,
                  "Content-Type": "application/json",
                }),
                body,
                signal: attemptSignal,
              }
            : {
                method,
                headers: outboundTraceHeaders(undefined, {
                  ...paramHeaders,
                  ...upstreamAuthHeaders,
                  "Content-Type": "application/json",
                }),
                signal: attemptSignal,
              };

        try {
          const response = await pinnedFetch(url, fetchOptions);

          if (response.ok) {
            // Record breaker/LB outcome only AFTER the body is fully read: if the
            // connection resets mid-stream, processRestSuccessResponse throws and
            // control falls to the catch below (a failure) — so one call can never
            // log both a success and a failure, which would otherwise keep a
            // half-broken backend's breaker from ever opening. A GraphQL-backed
            // tool can also answer 200 with a top-level errors[] and null data;
            // processRestSuccessResponse flags that as graphqlError so it records a
            // breaker FAILURE despite the 2xx status.
            const { result, graphqlError } = await processRestSuccessResponse(
              response,
              attempt,
              startTime,
              routing,
              built,
              call,
            );
            if (graphqlError) recordBreakerFailure();
            else recordBreakerSuccess();
            return result;
          }

          lastStatus = response.status;

          // Check if retryable
          if (isIdempotent && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
            proxyRetryAttempts.inc({ client: client.name, method, outcome: "retry" });
            // A3: handle Retry-After header (integer seconds OR HTTP-date). When
            // honored, flag it so the next iteration's exponential backoff is
            // skipped (the two waits must not stack).
            if (response.status === 429) {
              const waitMs = parseRetryAfter(response.headers.get("retry-after"));
              if (waitMs !== null && waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                retryAfterHonored = true;
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
            errorBodyText = await sanitizeRestResponse(errorBodyText, {
              redact: true,
              redactionPaths: built.redactionPaths,
              scanResponses: guardrails?.scanResponses ?? false,
              injectedAuthHeaders: upstreamAuthHeaders,
              client: client.name,
              tool: tool.name,
              mcpToolName,
              flaggedLogMessage: "Tool error response flagged by guardrail scan",
              applyBudget: false,
            });
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
          // Caller-initiated cancellation (MCP notifications/cancelled → opts.signal)
          // is not an upstream health signal, exactly like dispatch-mcp.ts's
          // result.cancelled branch: don't record a breaker failure (which would
          // push a healthy backend toward opening) and don't retry. Any half-open
          // probe canRequest() granted in resolveRestRouting is released by the
          // finally at the end of dispatchRestToolCall, so it can't strand.
          // reqController/timeout aborts fall through to the normal failure path below.
          if (opts?.signal?.aborted) {
            const durationMs = Date.now() - startTime;
            recordCallOutcome({
              client: client.name,
              tool: tool.name,
              keyId: callerKey?.id ?? null,
              statusClass: "cancelled",
              isError: false,
              durationMs,
              method,
            });
            log("info", "Tool call cancelled by caller", {
              tool: mcpToolName,
              client: client.name,
              duration_ms: durationMs,
            });
            return toolResult("Tool call cancelled by caller", { isError: true });
          }
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
  } finally {
    // See the block comment above the outer try: release the consumed half-open
    // probe on every exit path, but only if THIS call was the probe holder.
    if (probeGranted) breaker.releaseProbe();
  }
}
