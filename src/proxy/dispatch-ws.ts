import { config } from "../config.js";
import { toolResult } from "../lib/mcp-result.js";
import type { ToolCallOpts } from "./proxy.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { wsRequest, wsRequestPersistent } from "./backends.js";
import { recordToolCall, proxyRequestDuration } from "../observability/metrics.js";
import { recordUsage } from "../observability/usage.js";

/**
 * Dispatches a tool call over a WebSocket (per-tool `tool_ws` config).
 * Non-persistent (default): opens an ephemeral connection, sends the args as
 * JSON, and returns the first message. Persistent (`wsCfg.persistent`): stays
 * open across multiple messages, forwarding each as MCP progress (when the
 * caller requested it) and resolving with the last one — see
 * wsRequestPersistent in backends.ts. Either way, records success/failure on
 * the client breaker like the REST/MCP paths.
 */
export async function dispatchWsToolCall(
  client: RegisteredClient,
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>,
  wsCfg: { wsUrl: string; resolvedIp: string; enabled: boolean; persistent?: boolean },
  timeoutMs: number,
  breaker: ReturnType<typeof getCircuitBreaker>,
  callerKey: { id: number } | null,
  opts?: ToolCallOpts,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const startTime = Date.now();
  const cleanArgs = { ...rawArgs };
  delete cleanArgs.__confirm;
  delete cleanArgs.__approval_id;
  try {
    const text = wsCfg.persistent
      ? await wsRequestPersistent(
          wsCfg.wsUrl,
          JSON.stringify(cleanArgs),
          timeoutMs,
          config.maxResponseBytes,
          opts?.onProgress ? (data) => opts.onProgress!(0, undefined, data) : undefined,
        )
      : await wsRequest(wsCfg.wsUrl, JSON.stringify(cleanArgs), timeoutMs, config.maxResponseBytes);
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
    return toolResult(
      `WebSocket call failed for '${client.name}': ${err instanceof Error ? err.message : String(err)}`,
      { isError: true },
    );
  }
}
