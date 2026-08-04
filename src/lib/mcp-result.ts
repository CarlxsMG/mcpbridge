/**
 * The shared MCP CallTool result envelope used across the whole dispatch
 * pipeline (REST / WebSocket / MCP-upstream / composites / system tools) and
 * handed straight back to the MCP SDK.
 *
 * This is the ONE canonical shape. It unifies three types that had
 * independently converged on the same envelope:
 *   - `proxy/gates.ts`'s `ToolResult`
 *   - `mcp/mcp-upstream.ts`'s `ProxyToolResult`
 *   - this module's own `ToolCallResult` (the `toolResult()` helper's return)
 * closing the deferred ToolResult-dedup (#51). Both of the former re-export
 * `ToolResult` from here so existing importers keep compiling.
 *
 * Rich content (MCP 2025-06-18): a content item may be a text block
 * (`{ type: "text", text }`) OR a non-text block — image/audio
 * (`{ type, data, mimeType }`), an embedded resource
 * (`{ type: "resource", resource: { uri, text?, blob?, mimeType? } }`), a
 * `resource_link`, etc. `text` is therefore OPTIONAL, and an open index
 * signature carries whatever additional fields a block kind defines. A plain
 * `{ type: "text", text }` still satisfies it, so every builder in the codebase
 * stays assignable while an upstream MCP tool's rich content survives the bridge
 * intact instead of being flattened into a JSON text blob.
 */

/** One MCP CallTool content block — text or non-text (see module doc). */
export interface ToolResultContent {
  type: string;
  /** Present on text blocks (and on an embedded resource's `resource.text`). */
  text?: string;
  [key: string]: unknown;
}

/**
 * The uniform tool-call result envelope returned throughout the dispatch
 * pipeline.
 *
 * Declared as a `type` (not an `interface`) deliberately: the MCP SDK's server
 * request-handler result type is a loose `{ _meta?: ...; [x: string]: unknown }`
 * passthrough, and only a type-literal alias picks up TypeScript's implicit
 * index signature that makes it assignable there — an interface would not, and
 * `mcp-server.ts` returns this straight back to the SDK.
 */
export type ToolResult = {
  content: ToolResultContent[];
  /**
   * MCP 2025-06-18 structured tool output (mirrors the tool's `outputSchema`).
   * Threaded through from an MCP upstream; absent for REST/WS/composite results.
   * Every string leaf is sanitized (redaction + guardrail scan +
   * injected-credential strip) on the MCP dispatch path before it reaches the
   * caller — see dispatch-mcp.ts.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /**
   * True only when this result came from a caller-initiated cancellation, not an
   * upstream failure — the caller must not penalize the circuit breaker for it
   * (set on the MCP-upstream dispatch path only).
   */
  cancelled?: boolean;
  /**
   * Which policy gate refused this call — see {@link DenyCode}. Absent on
   * success and on failures that are not a policy decision (an upstream 500 is
   * not a deny).
   */
  denyCode?: DenyCode;
};

/**
 * The gate that refused a tool call.
 *
 * Every one of these is a decision the gateway exists to make, and until this
 * union existed none of them was recorded in a machine-readable form: a gate
 * rejected with prose, and the trace span stored `is_error: true` — one boolean
 * for ten different reasons. So "which gate refused this call" could only be
 * answered by string-matching an error message, and "how many calls did the
 * quota gate refuse this week" could not be answered at all.
 *
 * Resolution is per REASON, not per gate function: `checkClientToolAvailable`
 * alone covers three (disabled, unregistering, unreachable) and
 * `checkQuarantineAndApprovalGate` covers two, so tagging at the call site
 * would collapse exactly the distinctions an operator needs.
 *
 * These travel to the caller as well as to the trace. That is deliberate — the
 * code is the machine-readable form of prose the caller already receives, so it
 * discloses nothing new, and an MCP client's correct reaction differs sharply
 * between them (`rate_limit` is worth retrying, `key_scope` never is).
 */
export type DenyCode =
  /** Client or tool is disabled. */
  | "disabled"
  /** The client is mid-unregistration. */
  | "unregistering"
  /** Health loop has marked the client unreachable. */
  | "unreachable"
  /** Per-tool key allowlist refused this caller. */
  | "allowed_key"
  /** The managed key's scopes do not cover this tool. */
  | "key_scope"
  /** Consumer monthly quota or per-end-user rate limit exhausted. */
  | "quota"
  /** Sensitive tool called without `__confirm` or an elevated key. */
  | "confirm_required"
  /** Auto-quarantine is active in "block" mode. */
  | "quarantine"
  /** Human-in-the-loop approval pending or refused. */
  | "approval"
  /** Per-tool rate limit exceeded. */
  | "rate_limit"
  /** An input guardrail (deny rule or secret scan) matched. */
  | "guardrail_input"
  /** The tool name did not resolve to a registered client/tool. */
  | "unknown_tool";

/**
 * @deprecated Historical alias for {@link ToolResult}, retained so existing
 * `ToolCallResult` importers keep compiling. New code should use `ToolResult`.
 */
export type ToolCallResult = ToolResult;

/** Builds a single-text-part MCP CallTool result. Pass `{ isError: true }` for an error outcome. */
export function toolResult(text: string, opts: { isError?: boolean } = {}): ToolResult {
  return opts.isError ? { isError: true, content: [{ type: "text", text }] } : { content: [{ type: "text", text }] };
}

/**
 * Builds a gate rejection: the prose the caller reads, plus the {@link DenyCode}
 * the trace and traffic capture aggregate on.
 *
 * Use this at every point a policy refuses a call, rather than
 * `toolResult(text, { isError: true })` — the structural test in
 * `src/proxy/__tests__/deny-codes.test.ts` fails on a gate that still returns a
 * bare error result, so a gate added later cannot quietly go untagged.
 */
export function denyResult(code: DenyCode, text: string): ToolResult {
  return { isError: true, denyCode: code, content: [{ type: "text", text }] };
}
