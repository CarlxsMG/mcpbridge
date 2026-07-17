import { config } from "../config.js";
import { log } from "../logger.js";
import { toolResult, type ToolCallResult, type ToolResult } from "../lib/mcp-result.js";
import type { ToolCallOpts } from "./proxy.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import {
  requiresApproval,
  approvalArgsHash,
  createApproval,
  consumeApproval,
  notifyApproval,
  getRequiredLevels,
} from "../admin/entities/approvals.js";
import { checkConsumerQuota, checkEndUserRateLimit, getConsumer } from "../admin/entities/consumers.js";
import { isToolSensitive } from "../tool-meta/tool-sensitivity.js";
import { getToolMock } from "../tool-meta/tool-mock.js";
import { isDeleting } from "../mcp/registry.js";
import { isKeyAllowed } from "../security/key-hash.js";
import { resolveMcpKeyByToken, isToolInKeyScope } from "../security/mcp-key-store.js";
import { checkToolRateLimit } from "../middleware/rate-limiter.js";
import { checkSharedToolRateLimit } from "../db/rate-counters.js";
import { checkQuarantine, recordGuardrailHit } from "../tool-policies/quarantine.js";
import { getGuardrails, checkInputGuardrails } from "../tool-policies/guardrails.js";
import { cacheGet } from "../tool-policies/response-cache.js";
import { recordToolCall, cacheEvents } from "../observability/metrics.js";
import { recordUsage } from "../observability/usage.js";

/**
 * Resolves the caller-asserted end-user identity for this call, if any. The
 * header (threaded via ToolCallOpts.endUserId) wins when both are present:
 * it's set by the wrapping application's own request-construction code, not
 * influenced by anything an LLM emits as tool-call arguments (which could be
 * steered by prompt injection). Blank/non-string values are treated as absent.
 *
 * SECURITY NOTE: when the header is absent (the common case for a bare/raw
 * MCP client, or any deployment that doesn't thread X-End-User-Id through),
 * the __end_user *argument* is the only identity signal — and it comes
 * straight from the model's tool-call arguments. A prompt-injected or
 * malicious caller can therefore not only evade its own per-end-user limit
 * (self-harm, the originally-scoped risk) but also assert a SPECIFIC OTHER
 * end-user's id to burn that victim's bucket and deny their legitimate calls.
 * This is inherent to accepting any unauthenticated identity signal from tool
 * arguments; only deploy per-end-user rate limiting for a consumer where the
 * wrapping application reliably sets the header, or treat the arg-only path
 * as a fairness convenience with no adversarial guarantee at all.
 */
function resolveEndUserId(headerValue: string | undefined, args: Record<string, unknown>): string | null {
  const fromHeader = typeof headerValue === "string" ? headerValue.trim() : "";
  if (fromHeader) return fromHeader;
  const rawArg = (args as Record<string, unknown>).__end_user;
  const fromArg = typeof rawArg === "string" ? rawArg.trim() : "";
  return fromArg || null;
}

/**
 * Runs the human-in-the-loop approval ticket gate for one call: files a new
 * pending ticket (no __approval_id) or validates+consumes an existing one.
 * Returns a terminal result when the call must stop here, or null when it may
 * proceed. Shared by the natural per-tool `requiresApproval` check and by
 * quarantine's "force_approval" action, so ticket-creation logic never
 * duplicates between the two call sites.
 */
export function runApprovalGate(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  mcpToolName: string,
  callerKey: { id: number } | null,
): ToolResult | null {
  const rawApprovalId = (args as Record<string, unknown>).__approval_id;
  const approvalId = typeof rawApprovalId === "number" ? rawApprovalId : null;
  const argsHash = approvalArgsHash(args as Record<string, unknown>);
  if (approvalId === null) {
    const id = createApproval(
      client.name,
      tool.name,
      argsHash,
      JSON.stringify(args),
      callerKey?.id ?? null,
      getRequiredLevels(client.name, tool.name),
    );
    notifyApproval(id, client.name, tool.name);
    log("info", "Tool call queued for approval", { tool: mcpToolName, client: client.name, approval_id: id });
    return toolResult(
      `Tool '${mcpToolName}' requires human approval. Queued as approval #${id}. Once approved, re-call with {"__approval_id": ${id}}.`,
      { isError: true },
    );
  }
  const decision = consumeApproval(approvalId, client.name, tool.name, argsHash);
  if (!decision.ok) {
    return toolResult(decision.message, { isError: true });
  }
  return null;
}

// The uniform tool-call result shape (`ToolResult`) is now the single canonical
// type in lib/mcp-result.ts (dedup #51). Re-exported here so existing importers
// (dispatch-rest.ts et al.) that reach for it via `./gates.js` keep working.
export type { ToolResult };

/**
 * Multi-tenant monthly quota + optional caller-asserted per-end-user rate limit.
 * A named stage of dispatchToolCall's pre-flight guard sequence: returns a reject
 * result, or null to proceed.
 */
export function checkConsumerQuotaGate(
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
  args: Record<string, unknown>,
  opts: ToolCallOpts | undefined,
): ToolResult | null {
  if (callerKey?.consumerId == null) return null;
  // Fetched once and passed to both checks below — each independently calling
  // getConsumer() would be a second identical SQLite read per call.
  const consumer = getConsumer(callerKey.consumerId);
  const quota = checkConsumerQuota(callerKey.consumerId, consumer);
  if (quota.exceeded) {
    return toolResult(`Monthly quota exceeded for this API key's consumer (${quota.used}/${quota.quota})`, {
      isError: true,
    });
  }
  // Per-end-user rate limit (opt-in fairness dimension) — caller-asserted and
  // UNAUTHENTICATED: a fairness knob, not an authorization boundary. Zero overhead
  // unless the caller asserts an id AND the consumer opted in.
  const assertedEndUserId = resolveEndUserId(opts?.endUserId, args);
  if (assertedEndUserId !== null) {
    const endUserRl = checkEndUserRateLimit(callerKey.consumerId, assertedEndUserId, consumer);
    if (endUserRl.limited) {
      return toolResult(`End-user rate limit exceeded — retry after ${endUserRl.retryAfterSeconds}s`, {
        isError: true,
      });
    }
  }
  return null;
}

/**
 * Transport-agnostic step-up check — a sensitive operation requires an explicit
 * `__confirm: true` argument or an elevated credential. Shared by
 * `checkSensitiveToolGate` (below, for backend REST/MCP-upstream tool calls) and
 * `runSystemTool` (src/mcp/system-tools.ts, for the /mcp system-tool catalog) so
 * the confirm/elevated semantics and the exact rejection message are defined in
 * exactly one place and can't drift between the two dispatch paths. Returns a
 * reject result, or null to proceed.
 */
export function checkConfirmGate(
  sensitive: boolean,
  args: Record<string, unknown>,
  elevated: boolean,
  toolLabel: string,
): ToolCallResult | null {
  if (!sensitive) return null;
  const confirmed = args.__confirm === true;
  if (confirmed || elevated) return null;
  return toolResult(
    `Tool '${toolLabel}' is sensitive — pass {"__confirm": true} in arguments or call with an elevated key.`,
    { isError: true },
  );
}

/**
 * Destructive-action gate — a sensitive tool requires an explicit `__confirm: true`
 * argument or an elevated key. Returns a reject result, or null to proceed.
 */
export function checkSensitiveToolGate(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
  mcpToolName: string,
): ToolResult | null {
  return checkConfirmGate(
    isToolSensitive(client.name, tool.name, tool.method),
    args,
    callerKey?.elevated === true,
    mcpToolName,
  );
}

/**
 * Availability backstop — the tool should already be excluded from any tools/list
 * a caller saw, but a stale client-side cache could still call a disabled/deleting/
 * unreachable target directly. Returns a reject result, or null to proceed.
 */
export function checkClientToolAvailable(
  client: RegisteredClient,
  tool: RegisteredTool,
  mcpToolName: string,
): ToolResult | null {
  if (!client.enabled || !tool.enabled) {
    return toolResult(`Tool '${mcpToolName}' is disabled`, { isError: true });
  }
  if (isDeleting(client.name)) {
    return toolResult("Client is being unregistered", { isError: true });
  }
  if (client.status === "unreachable") {
    return toolResult(`Client '${client.name}' is unreachable`, { isError: true });
  }
  return null;
}

/**
 * Allowed-key restriction — fail closed: an explicit per-tool key allowlist must
 * hold even when global MCP auth is disabled/unconfigured. Returns a reject result,
 * or null to proceed.
 */
export function checkAllowedKeyGate(
  tool: RegisteredTool,
  callerToken: string | undefined,
  mcpToolName: string,
): ToolResult | null {
  if (!tool.guards?.allowedKeyHashes?.length) return null;
  if (!isKeyAllowed(callerToken, tool.guards.allowedKeyHashes)) {
    return toolResult(`Not authorized to call tool '${mcpToolName}'`, { isError: true });
  }
  return null;
}

/** Per-tool rate limit (shared cross-instance in HA, in-memory otherwise). Returns a reject result, or null. */
export function checkToolRateLimitGate(tool: RegisteredTool, mcpToolName: string): ToolResult | null {
  if (tool.guards?.rateLimitPerMin === undefined) return null;
  const rl = config.rateLimitShared
    ? checkSharedToolRateLimit(mcpToolName, tool.guards.rateLimitPerMin)
    : checkToolRateLimit(mcpToolName, tool.guards.rateLimitPerMin);
  if (!rl.allowed) {
    return toolResult(`Tool rate limit exceeded — retry after ${rl.retryAfterSeconds}s`, { isError: true });
  }
  return null;
}

/** Key-scope enforcement — a scoped managed key may only call clients/tools in its scope. Returns a reject result, or null. */
export function checkKeyScopeGate(
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
  client: RegisteredClient,
  mcpToolName: string,
): ToolResult | null {
  if (callerKey && !isToolInKeyScope(callerKey.scopes, client.name, mcpToolName)) {
    return toolResult(`API key is not authorized to call tool '${mcpToolName}'`, { isError: true });
  }
  return null;
}

/**
 * Auto-quarantine (escalates after N consecutive guardrail violations) plus the
 * human-in-the-loop approval-ticket gate. Quarantine's "force_approval" action
 * reuses the same approval gate, so the two live together (approvalGateHandled is
 * local). Returns a reject / approval-ticket result, or null to proceed.
 */
export function checkQuarantineAndApprovalGate(
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  mcpToolName: string,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
): ToolResult | null {
  let approvalGateHandled = false;
  const quarantine = checkQuarantine(client.name, tool.name);
  if (quarantine.active) {
    if (quarantine.action === "block") {
      log("warn", "Tool call blocked by quarantine", {
        tool: mcpToolName,
        client: client.name,
        reason: quarantine.reason,
      });
      return toolResult(
        `Tool '${mcpToolName}' is quarantined: ${quarantine.reason ?? "too many guardrail violations"}`,
        { isError: true },
      );
    }
    if (quarantine.action === "force_approval") {
      const gated = runApprovalGate(client, tool, args, mcpToolName, callerKey);
      approvalGateHandled = true;
      if (gated) return gated;
    } else if (quarantine.action === "observe") {
      log("warn", "Quarantined tool call allowed through (observe mode)", {
        tool: mcpToolName,
        client: client.name,
        reason: quarantine.reason,
      });
    }
  }
  // Human-in-the-loop approval (ticket model): no __approval_id files a pending
  // ticket bound to these exact args; a valid id is validated + consumed (single-use).
  if (!approvalGateHandled && requiresApproval(client.name, tool.name)) {
    const gated = runApprovalGate(client, tool, args, mcpToolName, callerKey);
    if (gated) return gated;
  }
  return null;
}

/**
 * Input-guardrail gate — deny-rule / secret checks on the arguments (records the
 * hit either way). The caller keeps the resolved `guardrails` for the response
 * scan on the output path. Returns a reject result, or null to proceed.
 */
export function checkGuardrailInputGate(
  guardrails: ReturnType<typeof getGuardrails>,
  client: RegisteredClient,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  mcpToolName: string,
): ToolResult | null {
  if (!guardrails) return null;
  const inputCheck = checkInputGuardrails(guardrails, args);
  if (inputCheck.blocked) {
    recordGuardrailHit(client.name, tool.name, true);
    log("warn", "Tool call rejected by input guardrail", {
      tool: mcpToolName,
      client: client.name,
      reason: inputCheck.reason,
    });
    return toolResult(`Input rejected by guardrail: ${inputCheck.reason}`, { isError: true });
  }
  recordGuardrailHit(client.name, tool.name, false);
  return null;
}

/** "always" mock short-circuit — serve a canned response without hitting the upstream. Returns the result, or null. */
export function checkMockAlwaysShortCircuit(
  mockCfg: ReturnType<typeof getToolMock> | null,
  client: RegisteredClient,
  tool: RegisteredTool,
  mcpToolName: string,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
): ToolResult | null {
  if (!(mockCfg?.enabled && mockCfg.mode === "always")) return null;
  recordToolCall(0, false);
  recordUsage({
    clientName: client.name,
    toolName: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass: "2xx",
    isError: false,
    durationMs: 0,
  });
  log("info", "Tool call served from mock", { tool: mcpToolName, client: client.name });
  return toolResult(mockCfg.response);
}

/** Response-cache lookup short-circuit — serve an idempotent GET from the TTL cache. Returns the cached result, or null. */
export function checkResponseCacheShortCircuit(
  responseCacheEnabled: boolean,
  responseCacheKey: string,
  client: RegisteredClient,
  tool: RegisteredTool,
  mcpToolName: string,
  callerKey: ReturnType<typeof resolveMcpKeyByToken>,
): ToolResult | null {
  if (!responseCacheEnabled) return null;
  const hit = cacheGet(responseCacheKey);
  if (hit) {
    cacheEvents.inc({ client: client.name, outcome: "hit" });
    recordToolCall(0, false);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: false,
      durationMs: 0,
    });
    log("info", "Tool call served from cache", { tool: mcpToolName, client: client.name });
    return { content: hit.content };
  }
  cacheEvents.inc({ client: client.name, outcome: "miss" });
  return null;
}
