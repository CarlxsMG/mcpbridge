/**
 * Shared MCP CallTool result envelope — `{ content: [{ type: "text", text }], isError? }`.
 *
 * Extracted from three independently-converged builders of the exact same
 * shape:
 *   - `mcp/mcp-upstream.ts`'s private `errorResult()` helper (the reference
 *     shape this module generalizes: always a single text part, `isError: true`)
 *   - `proxy/proxy.ts`'s `dispatchToolCall`/`dispatchWsToolCall`/
 *     `dispatchMcpToolCall`/`runApprovalGate`, which built this envelope ad hoc
 *     inline dozens of times (both success and error outcomes) instead of
 *     reusing a helper
 *   - `mcp/tool-search.ts`'s `runSearchTool()`, which builds both the success
 *     (ranked matches) and error (missing query) outcomes inline
 *
 * `isError` is omitted entirely on success (matching the many bare
 * `{ content: [...] }` returns already in the codebase) and set to `true` only
 * when explicitly requested, mirroring `errorResult()`'s own
 * `{ isError: true, content: [...] }` shape.
 */

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Builds a single-text-part MCP CallTool result. Pass `{ isError: true }` for an error outcome. */
export function toolResult(text: string, opts: { isError?: boolean } = {}): ToolCallResult {
  return opts.isError ? { isError: true, content: [{ type: "text", text }] } : { content: [{ type: "text", text }] };
}
