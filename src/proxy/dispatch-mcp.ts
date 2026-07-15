import { config } from "../config.js";
import { log } from "../logger.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolCallOpts } from "./proxy.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { getOrCompile } from "./schema-validator.js";
import { mcpUpstream } from "../mcp/mcp-upstream.js";
import type { McpConnParams } from "../mcp/mcp-upstream.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { getRedactionPaths, applyRedaction, stripInjectedCredentials } from "../content-filtering/redaction.js";
import { applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import { recordToolCall, proxyRequestDuration } from "../observability/metrics.js";
import { recordUsage } from "../observability/usage.js";

/**
 * Dispatches a tool call to an MCP-kind upstream via the outbound client pool.
 * The transport-agnostic gates in proxyToolCall have already run; this only
 * validates args and forwards. No method-based retry — MCP calls carry no
 * idempotency guarantee, so the pool reconnects on the NEXT call rather than
 * replaying this one.
 */
export async function dispatchMcpToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>,
  mcpToolName: string,
  effectiveTimeout: number,
  breaker: ReturnType<typeof getCircuitBreaker>,
  callerKey: { id: number } | null,
  scanResponses: boolean,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const startTime = Date.now();

  // Same Ajv instance/behaviour as the REST path — removeAdditional strips
  // unknown keys (including the sensitivity __confirm flag) before dispatch.
  const argsToSend = { ...rawArgs };
  const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
  if (!validate(argsToSend)) {
    // Arg validation failed before we reached the upstream — release any
    // half-open probe consumed by breaker.canRequest() in resolveRestRouting.
    // This exit records neither success nor failure, so without releasing it the
    // probe strands and wedges the breaker in half_open. No-op if none in flight.
    breaker.releaseProbe();
    const firstError = validate.errors?.[0];
    return toolResult(
      `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
      { isError: true },
    );
  }

  // Captured once and reused below to strip these same values back out of the
  // result: the gateway injects this credential into the upstream call, and a
  // caller authorized to CALL the tool must never receive it back if the upstream
  // reflects it (credential-broker property).
  const injectedAuthHeaders = getUpstreamAuthHeaders(client.name);
  const params: McpConnParams = {
    name: client.name,
    url: client.mcpUrl ?? client.base_url,
    transport: client.mcpTransport ?? "streamable-http",
    resolvedIp: client.resolved_ip,
    authHeaders: injectedAuthHeaders ?? undefined,
  };

  const result = await mcpUpstream.call(params, tool.upstreamName ?? tool.name, argsToSend, {
    timeoutMs: effectiveTimeout,
    maxBytes: config.maxResponseBytes,
    signal: opts?.signal,
    // Only ask the upstream for progress when the bridge itself has a
    // downstream sink to forward it to (the caller opted in via its own
    // _meta.progressToken) — never invent progress interest on its behalf.
    onprogress: opts?.onProgress ? (p) => opts.onProgress!(p.progress, p.total, p.message) : undefined,
  });

  const durationMs = Date.now() - startTime;
  // A caller-initiated cancellation is not an upstream health signal — it must
  // not be recorded against the breaker (mirrors how the REST path already
  // treats its own external cancellation distinctly from a real failure).
  const statusClass = result.cancelled ? "cancelled" : result.isError ? "error" : "2xx";
  if (!result.cancelled) {
    if (result.isError) breaker.recordFailure();
    else breaker.recordSuccess();
  } else {
    // Caller-initiated cancellation carries no upstream health signal, so it
    // records neither success nor failure (above). But if this call was the
    // half-open probe that canRequest() admitted in resolveRestRouting, it must
    // still be released — otherwise the probe strands in-flight and wedges the
    // breaker in half_open forever (every later call rejected as "Probing", and
    // the idle sweep never evicts because each rejected canRequest() refreshes
    // lastAccess). Same bail-before-recording exit class as the arg-validation
    // failure above. No-op unless a probe is actually in flight.
    breaker.releaseProbe();
  }

  recordToolCall(durationMs, result.isError === true);
  recordUsage({
    clientName: client.name,
    toolName: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass,
    isError: result.isError === true,
    durationMs,
  });
  proxyRequestDuration.observe({ client: client.name, method: "MCP", status_class: statusClass }, durationMs / 1000);
  log(
    result.cancelled ? "info" : result.isError ? "warn" : "info",
    result.cancelled
      ? "MCP tool call cancelled by caller"
      : result.isError
        ? "MCP tool call returned error"
        : "MCP tool call succeeded",
    { tool: mcpToolName, client: client.name, duration_ms: durationMs },
  );

  // Response redaction + guardrail-scan parity with the REST path — which
  // sanitizes its 4xx/5xx error branch too (proxy.ts, not just the success
  // branch). An isError result from an (untrusted) MCP upstream can carry a
  // secret at a configured redaction path, or a prompt-injection payload that
  // scanResponses is built to spotlight, exactly like a success result — so
  // both run over EVERY result regardless of result.isError.
  const paths = getRedactionPaths(client.name, tool.name);
  if (paths.length > 0) {
    result.content = result.content.map((item) =>
      item.type === "text" ? { ...item, text: applyRedaction(paths, item.text) ?? item.text } : item,
    );
  }
  // Response guardrail scan — wrap flagged text parts (after redaction).
  if (scanResponses) {
    let anyFlagged = false;
    result.content = result.content.map((item) => {
      if (item.type !== "text") return item;
      const scan = applyResponseScan(item.text);
      if (scan.flagged) {
        anyFlagged = true;
        log("warn", "MCP tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
      }
      return scan.flagged ? { ...item, text: scan.text } : item;
    });
    recordGuardrailHit(client.name, tool.name, anyFlagged);
  }

  // Context budget stays success-only — the REST path doesn't budget error
  // bodies either — and MUST run after redaction + the guardrail scan above so
  // an opt-in llm_summarize call only ever sees already-sanitized text, right
  // before the response goes back to the caller.
  if (!result.isError) {
    result.content = await Promise.all(
      result.content.map(async (item) => {
        if (item.type !== "text") return item;
        const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, item.text);
        return budgeted.applied === "none" ? item : { ...item, text: budgeted.text };
      }),
    );
  }

  // Strip the gateway's own injected upstream credential if the (untrusted)
  // upstream reflected it into a result part — parity with the REST path
  // (proxy.ts). Runs over EVERY result (success AND isError), independent of
  // redaction config, so a caller authorized to CALL this MCP-upstream tool can
  // never harvest the gateway-held credential it was never trusted to HOLD (nor
  // can traffic capture then persist it).
  if (injectedAuthHeaders) {
    result.content = result.content.map((item) =>
      item.type === "text" ? { ...item, text: stripInjectedCredentials(item.text, injectedAuthHeaders) } : item,
    );
  }

  return result;
}
