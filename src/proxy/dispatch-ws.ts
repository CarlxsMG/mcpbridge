import { config } from "../config.js";
import { log } from "../logger.js";
import { toolResult, type ToolResult } from "../lib/mcp-result.js";
import type { ToolCallOpts } from "./proxy.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { getOrCompile } from "./schema-validator.js";
import { wsRequest, wsRequestPersistent } from "./backends.js";
import { getRedactionPaths, applyRedaction } from "../content-filtering/redaction.js";
import { applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import { recordToolCall, proxyRequestDuration } from "../observability/metrics.js";
import { recordUsage } from "../observability/usage.js";
import { errorMessage } from "../lib/error-message.js";

/**
 * Dispatches a tool call over a WebSocket (per-tool `tool_ws` config).
 * Non-persistent (default): opens an ephemeral connection, sends the args as
 * JSON, and returns the first message. Persistent (`wsCfg.persistent`): stays
 * open across multiple messages, forwarding each as MCP progress (when the
 * caller requested it) and resolving with the last one — see
 * wsRequestPersistent in backends.ts. Either way, records success/failure on
 * the client breaker like the REST/MCP paths, and — on success — runs the same
 * response redaction → guardrail scan → context-budget pipeline the REST and
 * MCP paths apply, so per-(client,tool) policies aren't silently skipped for a
 * WS-backed tool.
 */
export async function dispatchWsToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>,
  mcpToolName: string,
  wsCfg: { wsUrl: string; resolvedIp: string; enabled: boolean; persistent?: boolean },
  timeoutMs: number,
  breaker: ReturnType<typeof getCircuitBreaker>,
  callerKey: { id: number } | null,
  scanResponses: boolean,
  opts?: ToolCallOpts,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Arg validation + unknown-key stripping parity with the REST/MCP paths. The
  // shared Ajv instance (removeAdditional:"all") drops the sensitivity __confirm
  // flag AND every other non-schema key — the internal __end_user / __approval_id
  // fields and any caller-supplied extras alike — so nothing beyond the tool's
  // declared inputs reaches the backend WS, and a missing/malformed required arg is
  // rejected up front instead of forwarded (the old code only deleted two keys and
  // validated nothing).
  const cleanArgs = { ...rawArgs };
  const validate = getOrCompile(client.name, tool.name, tool.inputSchema);
  if (!validate(cleanArgs)) {
    // Release any half-open probe consumed by breaker.canRequest() upstream so a
    // validation failure doesn't strand it and wedge the breaker in half_open.
    breaker.releaseProbe();
    const firstError = validate.errors?.[0];
    return toolResult(
      `Argument validation failed: ${firstError ? `${firstError.instancePath || "/"}: ${firstError.message}` : "unknown error"}`,
      { isError: true },
    );
  }
  try {
    let text = wsCfg.persistent
      ? await wsRequestPersistent(
          wsCfg.wsUrl,
          wsCfg.resolvedIp,
          JSON.stringify(cleanArgs),
          timeoutMs,
          config.maxResponseBytes,
          opts?.onProgress ? (data) => opts.onProgress!(0, undefined, data) : undefined,
        )
      : await wsRequest(wsCfg.wsUrl, wsCfg.resolvedIp, JSON.stringify(cleanArgs), timeoutMs, config.maxResponseBytes);
    breaker.recordSuccess();
    const durationMs = Date.now() - startTime;
    recordToolCall(durationMs, false);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "2xx",
      isError: false,
      durationMs,
    });
    proxyRequestDuration.observe({ client: client.name, method: "WS", status_class: "2xx" }, durationMs / 1000);

    // Response redaction parity with the REST/MCP paths — applyRedaction parses
    // JSON, redacts the configured dot-paths, and returns null on non-JSON so we
    // keep the raw text.
    const paths = getRedactionPaths(client.name, tool.name);
    if (paths.length > 0) {
      const redacted = applyRedaction(paths, text);
      if (redacted !== null) text = redacted;
    }
    // Response guardrail scan parity — spotlight-wrap flagged text after redaction.
    if (scanResponses) {
      const scan = applyResponseScan(text);
      recordGuardrailHit(client.name, tool.name, scan.flagged);
      if (scan.flagged) {
        log("warn", "WebSocket tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
        text = scan.text;
      }
    }
    // Context budget parity — MUST run last, after redaction and the guardrail
    // scan, so an opt-in llm_summarize call only ever sees sanitized text.
    const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, text);
    text = budgeted.text;

    return toolResult(text);
  } catch (err) {
    breaker.recordFailure();
    const durationMs = Date.now() - startTime;
    recordToolCall(durationMs, true);
    recordUsage({
      clientName: client.name,
      toolName: tool.name,
      keyId: callerKey?.id ?? null,
      statusClass: "error",
      isError: true,
      durationMs,
    });
    proxyRequestDuration.observe({ client: client.name, method: "WS", status_class: "error" }, durationMs / 1000);
    return toolResult(`WebSocket call failed for '${client.name}': ${errorMessage(err)}`, { isError: true });
  }
}
