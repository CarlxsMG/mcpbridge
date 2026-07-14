import { registry } from "../mcp/registry.js";
import { config } from "../config.js";
import { getToolCacheConfig, cacheKey } from "../tool-policies/response-cache.js";
import { getToolCoalesce, runCoalesced } from "../tool-policies/coalesce.js";
import { coalesceHits } from "../observability/metrics.js";
import { getToolMock } from "../tool-meta/tool-mock.js";
import { recordTraffic } from "../observability/traffic.js";
import { resolveMcpKeyByToken } from "../security/mcp-key-store.js";
import { getGuardrails } from "../tool-policies/guardrails.js";
import { tracingEnabled, startSpan, endSpan } from "../observability/tracing.js";
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
} from "./gates.js";
import { dispatchRestToolCall } from "./dispatch-rest.js";

// abortClientRequests / invalidatePinnedIp live in dispatch-rest.ts now, next to
// the per-client in-flight + pinned-IP state they operate on. Re-exported here so
// the registry (and any other consumer) keeps importing them from proxy.js.
export { abortClientRequests, invalidatePinnedIp } from "./dispatch-rest.js";

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
