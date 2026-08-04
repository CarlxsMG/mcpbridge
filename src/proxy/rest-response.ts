import { config } from "../config.js";
import { log } from "../logger.js";
import { proxyBodyCapRejections, proxyRetryAttempts, cacheEvents } from "../observability/metrics.js";
import { getToolCacheConfig, cacheSet } from "../tool-policies/response-cache.js";
import { getPaginationConfig } from "../tool-policies/pagination.js";
import { fetchAllPages } from "./pagination.js";
import { readBodyWithCap } from "./http-util.js";
import { getStreamingConfig, parseStream } from "./streaming.js";
import { applyOps } from "./transform.js";
import { resolveMcpKeyByToken } from "../security/mcp-key-store.js";
import { recordCallOutcome } from "../observability/call-outcome.js";
import { getRedactionPaths, applyRedaction, stripInjectedCredentials } from "../content-filtering/redaction.js";
import { getGuardrails, applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolResult } from "./gates.js";
import type { RestRequest } from "./rest-request.js";
import type { RestRouting } from "./dispatch-rest.js";

// ===========================================================================
// Stage 3 of the REST dispatch machine: turning an upstream HTTP response into
// an MCP tool result.
//
// Split out of dispatch-rest.ts alongside ./rest-request.ts. This module owns
// everything after the fetch resolves: GraphQL 200-with-errors detection (a
// transport-level success that is a real failure), response sanitizing
// (redaction, injected-credential stripping, guardrail response scan, context
// budget), and the success path's caching + outcome recording.
//
// The order inside sanitizeRestResponse is load-bearing and documented at each
// step — this is the last place a backend's bytes can be altered before an MCP
// client sees them.
// ===========================================================================
/** Per-call identity + response-cache context threaded into stage-3 response processing. */
export interface RestCallCtx {
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
 * True when a GraphQL-over-HTTP 200 body represents an execution FAILURE: a
 * non-empty top-level `errors[]` with `data` null or absent. GraphQL endpoints
 * answer 200 even for a failed query/mutation, signalling the failure only in
 * the body — so the transport-level `response.ok` hides it and the breaker would
 * never see it. Conservative by design: a partial success (some `data` present
 * alongside `errors`) returns false and stays a success. Called only for
 * GraphQL-configured tools (gated on RestRequest.graphqlEnabled), so ordinary
 * JSON that happens to carry an `errors` field is never affected.
 */
function isGraphqlErrorBody(rawText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.errors) || obj.errors.length === 0) return false;
  return obj.data === null || obj.data === undefined;
}

/**
 * The response-sanitization pipeline shared by the REST success and error exits,
 * in the ONE fixed order they must both run — redaction → guardrail scan →
 * injected-credential strip → (optional) context budget — kept here so the order
 * can't drift between the two copies (the hazard that motivated this extraction).
 * The credential strip runs BEFORE the context budget so an opt-in llm_summarize
 * never ships an un-stripped reflected credential to a third-party LLM.
 */
export async function sanitizeRestResponse(
  text: string,
  o: {
    redact: boolean;
    redactionPaths: ReturnType<typeof getRedactionPaths>;
    scanResponses: boolean;
    injectedAuthHeaders: Record<string, string>;
    client: string;
    tool: string;
    mcpToolName: string;
    flaggedLogMessage: string;
    applyBudget: boolean;
  },
): Promise<string> {
  let out = text;
  if (o.redact) {
    const redacted = applyRedaction(o.redactionPaths, out);
    if (redacted !== null) out = redacted;
  }
  if (o.scanResponses) {
    const scan = applyResponseScan(out);
    recordGuardrailHit(o.client, o.tool, scan.flagged);
    if (scan.flagged) {
      log("warn", o.flaggedLogMessage, { tool: o.mcpToolName, client: o.client });
      out = scan.text;
    }
  }
  out = stripInjectedCredentials(out, o.injectedAuthHeaders);
  if (o.applyBudget) {
    const budgeted = await applyContextBudget(o.client, o.tool, o.mcpToolName, out);
    out = budgeted.text;
  }
  return out;
}

/**
 * Stage 3 of dispatchRestToolCall — success-response processing. Given a known-good (2xx) Response,
 * reads the body under the streaming size cap (rejecting oversize — proxyBodyCapRejections), records
 * metrics/usage, then runs the streaming-normalize / paginate → response-transform → redaction →
 * guardrail-scan → context-budget → cache-set pipeline and returns the final ToolResult. No upstream
 * response header is forwarded (Fix 1). Returns `graphqlError` alongside the result: a GraphQL-backed
 * tool answers 200 even for a failed operation (top-level `errors[]` with null/absent `data`), so the
 * caller records a breaker FAILURE (not success) for that case even though the HTTP status was 2xx.
 * The caller otherwise records breaker/LB success only AFTER this returns, so a 2xx whose body then
 * resets mid-stream counts as a failure, not a success; the retry/error control flow stays in
 * dispatchRestToolCall.
 */
export async function processRestSuccessResponse(
  response: Response,
  attempt: number,
  startTime: number,
  routing: RestRouting,
  req: RestRequest,
  call: RestCallCtx,
): Promise<{ result: ToolResult; graphqlError: boolean }> {
  const { effectiveTimeout, route } = routing;
  const {
    method,
    targetBaseUrl,
    resolvedPath,
    queryParams,
    pinnedFetch,
    originalHost,
    upstreamAuthHeaders,
    paramHeaders,
    transformCfg,
    redactionPaths,
    graphqlEnabled,
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
    recordCallOutcome({
      client: client.name,
      tool: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: true,
      durationMs: Date.now() - startTime,
      method,
    });
    return {
      result: toolResult("Upstream response exceeded MAX_RESPONSE_BYTES limit", { isError: true }),
      graphqlError: false,
    };
  }

  // GraphQL-over-HTTP failure hiding behind a 200 — only for GraphQL-backed
  // tools, and only when `data` is null/absent (a partial success stays a
  // success). The body still flows through the processing pipeline below (so the
  // caller sees the errors payload), but isError/breaker/usage below all treat it
  // as a failure.
  const graphqlError = graphqlEnabled && isGraphqlErrorBody(rawText);

  if (attempt > 0) {
    proxyRetryAttempts.inc({ client: client.name, method, outcome: "success" });
  }
  log(
    graphqlError ? "warn" : "info",
    graphqlError ? "GraphQL tool returned errors with null data" : "Tool call succeeded",
    {
      tool: mcpToolName,
      client: client.name,
      status: response.status,
      duration_ms: Date.now() - startTime,
      attempts: attempt + 1,
    },
  );
  recordCallOutcome({
    client: client.name,
    tool: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass: "2xx",
    isError: graphqlError,
    durationMs: Date.now() - startTime,
    method,
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
        // Only the query-located args — NOT header/cookie params, which must not
        // leak into follow-up page URLs (they're carried as headers below).
        baseQuery: new URLSearchParams(queryParams),
        pinnedFetch,
        originalHost,
        // Same header set + precedence as page 1: in:header/cookie params first,
        // gateway-managed auth wins. Without this, pages 2+ drop those headers
        // and the backend rejects them (silent truncation to page 1).
        headers: { ...paramHeaders, ...upstreamAuthHeaders },
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

  // Redaction only parses/pretty-prints a JSON body; the guardrail scan +
  // credential strip + context budget always run (see sanitizeRestResponse).
  const responseText = await sanitizeRestResponse(bodyText, {
    redact: contentType.includes("application/json"),
    redactionPaths,
    scanResponses: guardrails?.scanResponses ?? false,
    injectedAuthHeaders: upstreamAuthHeaders,
    client: client.name,
    tool: tool.name,
    mcpToolName,
    flaggedLogMessage: "Tool response flagged by guardrail scan",
    applyBudget: true,
  });

  // Never cache a GraphQL error body — a cache hit would then serve the failure
  // as a success (breaker/usage bypassed) for the whole TTL.
  if (responseCacheEnabled && cacheCfg && !route.useSecondary && !graphqlError) {
    cacheSet(responseCacheKey, { content: [{ type: "text", text: responseText }] }, cacheCfg.ttlSeconds);
    cacheEvents.inc({ client: client.name, outcome: "store" });
  }
  return { result: toolResult(responseText, { isError: graphqlError }), graphqlError };
}
