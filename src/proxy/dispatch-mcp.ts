import { config } from "../config.js";
import { log } from "../logger.js";
import { toolResult, type ToolResult, type ToolResultContent } from "../lib/mcp-result.js";
import type { ToolCallOpts } from "./proxy.js";
import type { RegisteredClient, RegisteredTool } from "../mcp/types.js";
import { getCircuitBreaker } from "../middleware/circuit-breaker.js";
import { getOrCompile } from "./schema-validator.js";
import { mcpUpstream } from "../mcp/mcp-upstream.js";
import type { McpConnParams } from "../mcp/mcp-upstream.js";
import { getUpstreamAuthHeaders } from "../backend-auth/upstream-auth.js";
import { getRedactionPaths, applyRedaction, stripInjectedCredentials } from "../content-filtering/redaction.js";
import { mapStringLeaves } from "../content-filtering/walk-strings.js";
import { applyResponseScan } from "../tool-policies/guardrails.js";
import { recordGuardrailHit } from "../tool-policies/quarantine.js";
import { applyContextBudget } from "../tool-policies/context-budget.js";
import { recordCallOutcome } from "../observability/call-outcome.js";

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
): Promise<ToolResult> {
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

  recordCallOutcome({
    client: client.name,
    tool: tool.name,
    keyId: callerKey?.id ?? null,
    statusClass,
    isError: result.isError === true,
    durationMs,
    method: "MCP",
  });
  log(
    result.cancelled ? "info" : result.isError ? "warn" : "info",
    result.cancelled
      ? "MCP tool call cancelled by caller"
      : result.isError
        ? "MCP tool call returned error"
        : "MCP tool call succeeded",
    { tool: mcpToolName, client: client.name, duration_ms: durationMs },
  );

  // Response sanitization — redaction + guardrail scan + injected-credential
  // strip — extended to cover the ENTIRE rich MCP 2025-06-18 result surface the
  // passthrough now preserves: text parts, embedded-resource `resource.text`,
  // AND every string leaf of `structuredContent`. Nothing reaches the caller
  // unscanned. All three run over EVERY result (success AND isError), matching
  // the REST path which sanitizes its 4xx/5xx branch too — an untrusted upstream
  // can carry a secret or a prompt-injection payload in an error body just as
  // easily as in a success one.

  // (1) Redaction — path-based, over the content blocks only (text parts,
  // resource.text/uri, resource_link fields — none of which are schema-validated).
  // structuredContent is DELIBERATELY not redaction-mutated: it is the typed
  // output validated by the caller's SDK against the advertised outputSchema, and
  // swapping a matched value for the "[REDACTED]" string would violate that schema
  // (e.g. a numeric field), making the SDK reject the whole call. Redaction paths
  // still apply to the text mirror of the data; the one structuredContent leak
  // that matters — a reflected gateway credential — is closed by the
  // type-preserving credential strip in (3).
  const paths = getRedactionPaths(client.name, tool.name);
  if (paths.length > 0) {
    const redact = (s: string): string => applyRedaction(paths, s) ?? s;
    result.content = result.content.map((item) => mapItemStrings(item, redact));
  }

  // (2) Guardrail response scan — spotlight-wrap any flagged string in the content
  // blocks. structuredContent is scanned DETECT-ONLY (flag + quarantine signal,
  // no mutation): wrapping a flagged leaf would break the advertised outputSchema
  // the same way redaction would. A single hit anywhere records exactly one
  // guardrail hit + one warn log.
  if (scanResponses) {
    let anyFlagged = false;
    const scan = (s: string): string => {
      const scanned = applyResponseScan(s);
      if (scanned.flagged) anyFlagged = true;
      return scanned.text;
    };
    result.content = result.content.map((item) => mapItemStrings(item, scan));
    if (result.structuredContent) {
      // Detect only — run the scan to raise the flag/quarantine signal, but keep
      // the original typed value so it still conforms to the outputSchema.
      void mapStringLeaves(result.structuredContent, scan);
    }
    if (anyFlagged) {
      log("warn", "MCP tool response flagged by guardrail scan", { tool: mcpToolName, client: client.name });
    }
    recordGuardrailHit(client.name, tool.name, anyFlagged);
  }

  // (3) Strip the gateway's own injected upstream credential if the (untrusted)
  // upstream reflected it — over text parts, resource.text, AND every
  // structuredContent string leaf (a reflected credential is just as harvestable
  // from structured output as from a text part). Runs over EVERY result,
  // independent of redaction config, so a caller authorized to CALL this
  // MCP-upstream tool can never harvest the gateway-held credential it was never
  // trusted to HOLD (nor can traffic capture then persist it). Binary
  // `data`/`blob` (base64) is deliberately NOT scanned here: it is not
  // prompt-injection-scannable, and a reflected plaintext credential would have
  // to survive base64 transport verbatim — the needle-match strip below only
  // matches the raw credential string, which the text/resource-text surfaces it
  // could actually be reflected into already cover. MUST run BEFORE the context
  // budget below, whose opt-in llm_summarize can ship result text to a
  // third-party LLM — stripping after that would leak a reflected credential to
  // the summarizer.
  if (injectedAuthHeaders) {
    const strip = (s: string): string => stripInjectedCredentials(s, injectedAuthHeaders);
    result.content = result.content.map((item) => mapItemStrings(item, strip));
    if (result.structuredContent) {
      result.structuredContent = mapStringLeaves(result.structuredContent, strip) as Record<string, unknown>;
    }
  }

  // (4) Context budget stays success-only (the REST path doesn't budget error
  // bodies either) and TEXT-only, and MUST run after redaction, the guardrail
  // scan, AND the credential strip above so an opt-in llm_summarize call only
  // ever sees already-sanitized text, right before the response goes back to the
  // caller. structuredContent is intentionally not budgeted (truncating
  // structured output would break its outputSchema contract).
  if (!result.isError) {
    result.content = await Promise.all(
      result.content.map(async (item) => {
        if (item.type !== "text" || typeof item.text !== "string") return item;
        const budgeted = await applyContextBudget(client.name, tool.name, mcpToolName, item.text);
        return budgeted.applied === "none" ? item : { ...item, text: budgeted.text };
      }),
    );
  }

  return result;
}

/**
 * Content-item string leaves that must NOT be transformed: the block
 * discriminator `type` (transforming it would corrupt the block), and the binary
 * base64 payloads `data`/`blob` (not prompt-injection-scannable, and a reflected
 * plaintext credential can't survive base64 verbatim — the string surfaces it
 * could be reflected into are covered below).
 */
const CONTENT_ITEM_SKIP_KEYS: ReadonlySet<string> = new Set(["type", "data", "blob"]);

/**
 * Applies a string transform to EVERY non-binary caller-visible string inside one
 * content item — a text block's `text`, an embedded-resource's `resource.text`
 * AND `resource.uri`/`mimeType`, and a `resource_link`'s `uri`/`name`/`title`/
 * `description` — since an untrusted upstream can smuggle a prompt-injection
 * payload or a reflected credential through ANY of them, not just `text`. Content
 * items are not validated against the tool's outputSchema (only structuredContent
 * is), so mutating these strings is safe. Binary `data`/`blob` and the block
 * `type` discriminator are left untouched (CONTENT_ITEM_SKIP_KEYS).
 */
function mapItemStrings(item: ToolResultContent, fn: (s: string) => string): ToolResultContent {
  return mapStringLeaves(item, fn, CONTENT_ITEM_SKIP_KEYS) as ToolResultContent;
}
